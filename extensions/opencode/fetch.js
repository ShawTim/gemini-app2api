import crypto from 'node:crypto';
import { NativeDirectProvider } from '../../src/native-provider.mjs';
import { openDirectTurn as defaultOpenDirectTurn } from '../../src/gateway/native-transport.mjs';
import { createImageBlobCache } from '../../src/gateway/image-upload.mjs';
import { automaticRecoveryKind as defaultAutomaticRecoveryKind } from '../../src/gateway/automatic-recovery.mjs';
import { measurePromptImagePayload, estimateUsage } from '../../src/openai-usage.mjs';
import { toChatAnnotations } from '../../src/openai-contract.mjs';
import { normalizeOpenCodeModelId } from './models.js';

const KEEPALIVE_INTERVAL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 300_000;

function jsonErrorResponse(error) {
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
    ? error.status
    : error?.code === 'NATIVE_PERMISSION_OR_AUTH' ||
        error?.code === 'OAUTH_REFRESH_FAILED' ||
        error?.code === 'OAUTH_LOGGED_OUT' ||
        error?.code === 'OAUTH_ACCOUNT_CHANGED'
      ? 401
      : error?.code === 'NATIVE_QUOTA_EXHAUSTED'
        ? 429
        : 502;
  const code = typeof error?.code === 'string' && error.code ? error.code : 'UPSTREAM_ERROR';
  const type = status === 429
    ? 'rate_limit_error'
    : status === 401 || status === 403
      ? 'authentication_error'
      : status >= 500
        ? 'server_error'
        : 'invalid_request_error';
  const message = error?.upstreamMessage
    ? `${code}: ${error.upstreamMessage}`
    : error?.message || code;
  return new Response(
    JSON.stringify({
      error: {
        message,
        type,
        code,
        param: error?.param ?? null,
      },
    }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function measurePromptChars(payload) {
  if (!Array.isArray(payload?.messages)) return 0;
  let total = 0;
  for (const m of payload.messages) {
    if (typeof m?.content === 'string') total += m.content.length;
    else if (Array.isArray(m?.content)) {
      for (const p of m.content) {
        if (typeof p?.text === 'string') total += p.text.length;
      }
    }
    if (Array.isArray(m?.tool_calls)) {
      total += JSON.stringify(m.tool_calls).length;
    }
  }
  if (Array.isArray(payload?.tools) && payload.tools.length) {
    total += JSON.stringify(payload.tools).length;
  }
  return total;
}

async function readRequestJson(input, init) {
  if (typeof init?.body === 'string') return JSON.parse(init.body);
  if (init?.body instanceof Uint8Array) return JSON.parse(Buffer.from(init.body).toString('utf8'));
  if (init?.body instanceof ArrayBuffer) return JSON.parse(Buffer.from(init.body).toString('utf8'));
  if (input instanceof Request) return await input.clone().json();
  throw Object.assign(new Error('Expected JSON request body'), { code: 'INVALID_JSON', status: 400 });
}

function getRequestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === 'string') return input.url;
  return '';
}

function getRequestSignal(input, init) {
  return init?.signal ?? (input instanceof Request ? input.signal : undefined);
}

export function createOpenCodeFetch({
  resolveAccessToken,
  getSubscriptionTier = () => 'unknown',
  openTurn = defaultOpenDirectTurn,
  uploadImages,
  automaticRecoveryKind = defaultAutomaticRecoveryKind,
  fallbackFetch = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  keepaliveMs = KEEPALIVE_INTERVAL_MS,
} = {}) {
  if (typeof resolveAccessToken !== 'function') {
    throw new TypeError('resolveAccessToken is required');
  }
  const blobCache = createImageBlobCache();

  async function runWithRetry({ rawBody, requestedModel, signal, onDelta, getOutputCommitState, onModelResolved }) {
    let attempts = 0;
    let recoveryCode;
    let authRefreshed = false;

    while (true) {
      let currentToken;
      let currentTier;
      try {
        const resolved = await resolveAccessToken({ signal, forceRefresh: authRefreshed });
        if (typeof resolved === 'string') {
          currentToken = resolved;
          currentTier = getSubscriptionTier();
        } else {
          currentToken = resolved?.accessToken;
          currentTier = resolved?.subscriptionTier ?? getSubscriptionTier();
        }
        if (typeof currentToken !== 'string' || !currentToken) {
          throw Object.assign(new Error('OAuth did not return a valid access token'), {
            code: 'OAUTH_REFRESH_FAILED',
            status: 401,
          });
        }
      } catch (err) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
          code: err?.code || 'OAUTH_REFRESH_FAILED',
          status: 401,
        });
      }

      // Compute effective model & gemini-auto AFTER resolving the active account's token and tier.
      const effectiveModel = currentTier === 'free' ? 'gemini-auto' : requestedModel;
      const isAuto = effectiveModel === 'gemini-auto';
      const payload = { ...rawBody, model: effectiveModel };
      if (isAuto) {
        delete payload.thinking_level;
        delete payload.reasoning_effort;
        delete payload.reasoning;
      }
      onModelResolved?.(effectiveModel);

      const provider = new NativeDirectProvider(
        { getValidAccessToken: async () => currentToken },
        {
          openTurn,
          ...(uploadImages ? { uploadImages } : {}),
          blobCache,
          modelAlias: payload.model,
          allowAutoModel: isAuto,
          timeoutMs,
        },
      );

      try {
        return await provider.runTurn('opencode-session', payload, onDelta, {
          incrementalOutput: Boolean(payload.stream),
          signal,
          recoveryCode,
          getOutputCommitState,
          timeoutMs,
        });
      } catch (err) {
        const commitState = getOutputCommitState();
        const committed = commitState.publishedBytes > 0 || commitState.toolCallCount > 0;
        if (!committed && !signal?.aborted) {
          if (err?.code === 'NATIVE_PERMISSION_OR_AUTH' && !authRefreshed) {
            authRefreshed = true;
            continue;
          }
          const kind = automaticRecoveryKind(err, payload.model, { allowAutoModel: isAuto });
          if (kind && kind !== 'quota' && attempts < 1) {
            attempts++;
            recoveryCode = err.code;
            continue;
          }
        }
        throw err;
      }
    }
  }

  return async function openCodeGeminiFetch(input, init = {}) {
    const rawUrl = getRequestUrl(input);
    let pathname = '';
    try {
      pathname = new URL(rawUrl).pathname;
    } catch {
      return fallbackFetch(input, init);
    }

    if (!pathname.endsWith('/chat/completions')) {
      return fallbackFetch(input, init);
    }

    const callerSignal = getRequestSignal(input, init);
    let rawBody;
    try {
      rawBody = await readRequestJson(input, init);
    } catch (err) {
      return jsonErrorResponse(Object.assign(err, { code: 'INVALID_JSON', status: 400 }));
    }

    const requestedModel = normalizeOpenCodeModelId(rawBody?.model);
    let effectiveModel = requestedModel;

    const stream = Boolean(rawBody?.stream);
    const includeUsage = Boolean(rawBody?.stream_options?.include_usage);
    const promptChars = measurePromptChars(rawBody || {});
    const { imageCount } = measurePromptImagePayload(rawBody || {});
    const created = Math.floor(Date.now() / 1000);
    const completionId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;

    if (!stream) {
      try {
        const result = await runWithRetry({
          rawBody,
          requestedModel,
          signal: callerSignal,
          onDelta: () => {},
          getOutputCommitState: () => ({ publishedBytes: 0, toolCallCount: 0 }),
          onModelResolved: (m) => { effectiveModel = m; },
        });
        const outputBytes = Buffer.byteLength(
          (result.content || '') + (result.calls?.length ? JSON.stringify(result.calls) : ''),
          'utf8',
        );
        const usage = estimateUsage({ promptChars, imageCount, outputBytes });
        const finishReason = result.incomplete ? null : result.calls?.length ? 'tool_calls' : 'stop';
        const message = {
          role: 'assistant',
          content: result.calls?.length && !result.content ? null : (result.content || ''),
          ...(result.calls?.length ? { tool_calls: result.calls } : {}),
          ...(result.annotations?.length ? { annotations: toChatAnnotations(result.annotations) } : {}),
        };
        return new Response(
          JSON.stringify({
            id: result.id || completionId,
            object: 'chat.completion',
            created,
            model: result.model || effectiveModel,
            ...(result.incomplete ? { status: 'incomplete', incomplete_details: result.incompleteDetails ?? { reason: 'interrupted' } } : {}),
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      } catch (err) {
        return jsonErrorResponse(err);
      }
    }

    // Streaming SSE response: defer HTTP 200 headers until first verified output (or completion)
    // so pre-output validation / auth / upstream errors return genuine 4xx/5xx JSON responses,
    // and link ReadableStream.cancel() to abort the underlying Google HTTP/2 turn.
    const encoder = new TextEncoder();
    const streamAbort = new AbortController();
    const onCallerAbort = () => streamAbort.abort(callerSignal?.reason || new Error('Aborted'));
    if (callerSignal) {
      if (callerSignal.aborted) streamAbort.abort(callerSignal.reason);
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }

    let resolveStart;
    let rejectStart;
    let startSettled = false;
    const startGate = new Promise((resolve, reject) => {
      resolveStart = () => {
        if (!startSettled) {
          startSettled = true;
          resolve();
        }
      };
      rejectStart = (err) => {
        if (!startSettled) {
          startSettled = true;
          reject(err);
        }
      };
    });

    const pendingChunks = [];
    let streamController = null;
    let streamEnded = false;
    let streamClosed = false;
    let publishedBytes = 0;
    let toolCallCount = 0;
    let sentRole = false;
    let emittedAny = false;
    let keepaliveTimer = null;

    const cleanup = () => {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
    };

    const pushSse = (text) => {
      if (streamClosed) return;
      const bytes = encoder.encode(text);
      if (streamController) {
        try {
          streamController.enqueue(bytes);
        } catch {
          streamClosed = true;
          streamAbort.abort(new Error('Stream consumer closed'));
        }
      } else {
        pendingChunks.push(bytes);
      }
    };

    const finishSse = () => {
      cleanup();
      streamEnded = true;
      if (streamController && !streamClosed) {
        streamClosed = true;
        try {
          streamController.close();
        } catch {}
      }
    };

    const sendDeltaChunk = (delta, finishReason = null, extra = {}) => {
      const chunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: effectiveModel,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...extra,
      };
      pushSse(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    const sendUsageChunk = (usage) => {
      const chunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: effectiveModel,
        choices: [],
        usage,
      };
      pushSse(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    const ensureRoleSent = () => {
      if (!sentRole) {
        sentRole = true;
        sendDeltaChunk({ role: 'assistant' }, null);
        resolveStart();
        if (keepaliveMs > 0 && !keepaliveTimer) {
          keepaliveTimer = setInterval(() => {
            pushSse(': keepalive\n\n');
          }, keepaliveMs);
          keepaliveTimer.unref?.();
        }
      }
    };

    (async () => {
      try {
        const result = await runWithRetry({
          rawBody,
          requestedModel,
          signal: streamAbort.signal,
          getOutputCommitState: () => ({ publishedBytes, toolCallCount }),
          onModelResolved: (m) => { effectiveModel = m; },
          onDelta: async (ev) => {
            if (!ev || typeof ev !== 'object') return;
            if (ev.reset && !emittedAny) return;
            if (typeof ev.content === 'string' && ev.content.length > 0) {
              ensureRoleSent();
              emittedAny = true;
              publishedBytes += Buffer.byteLength(ev.content, 'utf8');
              sendDeltaChunk({ content: ev.content }, null);
            }
            if (ev.call) {
              ensureRoleSent();
              emittedAny = true;
              const index = toolCallCount++;
              publishedBytes += Buffer.byteLength(JSON.stringify(ev.call), 'utf8');
              sendDeltaChunk({ tool_calls: [{ index, ...ev.call }] }, null);
            }
          },
        });

        ensureRoleSent();
        const finishReason = toolCallCount > 0 || result.calls?.length ? 'tool_calls' : 'stop';
        const annotations = result.annotations?.length ? toChatAnnotations(result.annotations) : null;
        sendDeltaChunk(annotations ? { annotations } : {}, finishReason);
        if (includeUsage) {
          const usage = estimateUsage({ promptChars, imageCount, outputBytes: publishedBytes });
          sendUsageChunk(usage);
        }
        pushSse('data: [DONE]\n\n');
      } catch (err) {
        if (!sentRole) {
          rejectStart(err);
          cleanup();
          streamEnded = true;
          streamClosed = true;
          return;
        }
        if (
          !streamAbort.signal.aborted &&
          err?.code === 'NATIVE_TURN_TIMEOUT' &&
          err?.unverifiedOutput !== true &&
          err?.postOutputIdleStall === true &&
          (publishedBytes > 0 || toolCallCount > 0)
        ) {
          sendDeltaChunk({}, toolCallCount > 0 ? 'tool_calls' : 'stop', { incomplete: true });
          if (includeUsage) {
            const usage = estimateUsage({ promptChars, imageCount, outputBytes: publishedBytes });
            sendUsageChunk(usage);
          }
          pushSse('data: [DONE]\n\n');
        } else {
          pushSse(
            `data: ${JSON.stringify({
              error: {
                code: err?.code || 'UPSTREAM_ERROR',
                message: err?.upstreamMessage || err?.message || 'Generation failed',
              },
              incomplete: true,
            })}\n\n`,
          );
          pushSse('data: [DONE]\n\n');
        }
      } finally {
        finishSse();
      }
    })();

    try {
      await startGate;
    } catch (err) {
      return jsonErrorResponse(err);
    }

    const sseStream = new ReadableStream({
      start(controller) {
        streamController = controller;
        while (pendingChunks.length > 0 && !streamClosed) {
          try {
            controller.enqueue(pendingChunks.shift());
          } catch {
            streamClosed = true;
            streamAbort.abort(new Error('Stream consumer closed'));
            break;
          }
        }
        if (streamEnded && !streamClosed) {
          streamClosed = true;
          try {
            controller.close();
          } catch {}
        }
      },
      cancel(reason) {
        streamClosed = true;
        cleanup();
        streamAbort.abort(reason instanceof Error ? reason : new Error('Stream cancelled by consumer'));
      },
    });

    return new Response(sseStream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      },
    });
  };
}
