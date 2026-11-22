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
    : error?.code === 'NATIVE_PERMISSION_OR_AUTH' || error?.code === 'OAUTH_REFRESH_FAILED'
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

  async function runWithRetry({ payload, isAuto, signal, onDelta, getOutputCommitState }) {
    let attempts = 0;
    let recoveryCode;
    let authRefreshed = false;

    while (true) {
      let currentToken;
      try {
        currentToken = await resolveAccessToken({ signal, forceRefresh: authRefreshed });
      } catch (err) {
        throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
          code: err?.code || 'OAUTH_REFRESH_FAILED',
          status: 401,
        });
      }

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
          const kind = automaticRecoveryKind(err);
          if (kind && attempts < 1) {
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

    const signal = getRequestSignal(input, init);
    let rawBody;
    try {
      rawBody = await readRequestJson(input, init);
    } catch (err) {
      return jsonErrorResponse(Object.assign(err, { code: 'INVALID_JSON', status: 400 }));
    }

    const requestedModel = normalizeOpenCodeModelId(rawBody?.model);
    const tier = getSubscriptionTier();
    const effectiveModel = tier === 'free' ? 'gemini-auto' : requestedModel;
    const isAuto = effectiveModel === 'gemini-auto';

    // Strip known unsupported OpenCode / AI SDK extras cleanly before canonical normalization.
    const payload = { ...rawBody, model: effectiveModel };
    if (isAuto) {
      delete payload.thinking_level;
      delete payload.reasoning_effort;
      delete payload.reasoning;
    }

    const stream = Boolean(payload.stream);
    const includeUsage = Boolean(payload.stream_options?.include_usage);
    const promptChars = measurePromptChars(payload);
    const { imageCount } = measurePromptImagePayload(payload);
    const created = Math.floor(Date.now() / 1000);
    const completionId = `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;

    if (!stream) {
      try {
        const result = await runWithRetry({
          payload,
          isAuto,
          signal,
          onDelta: () => {},
          getOutputCommitState: () => ({ publishedBytes: 0, toolCallCount: 0 }),
        });
        const outputBytes = Buffer.byteLength(
          (result.content || '') + (result.calls?.length ? JSON.stringify(result.calls) : ''),
          'utf8',
        );
        const usage = estimateUsage({ promptChars, imageCount, outputBytes });
        const finishReason = result.calls?.length ? 'tool_calls' : 'stop';
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
            choices: [{ index: 0, message, finish_reason: finishReason }],
            usage,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      } catch (err) {
        return jsonErrorResponse(err);
      }
    }

    // Streaming SSE response via Web ReadableStream
    const encoder = new TextEncoder();
    const sseStream = new ReadableStream({
      async start(controller) {
        let closed = false;
        let publishedBytes = 0;
        let toolCallCount = 0;
        let sentRole = false;
        let emittedAny = false;
        let keepaliveTimer = null;

        const safeEnqueue = (text) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            closed = true;
          }
        };

        const safeClose = () => {
          if (keepaliveTimer) {
            clearInterval(keepaliveTimer);
            keepaliveTimer = null;
          }
          if (!closed) {
            closed = true;
            try {
              controller.close();
            } catch {}
          }
        };

        const sendChunk = (delta, finishReason = null, usage = undefined) => {
          const chunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: effectiveModel,
            choices: finishReason === undefined
              ? []
              : [{ index: 0, delta, finish_reason: finishReason }],
            ...(usage !== undefined ? { usage } : {}),
          };
          safeEnqueue(`data: ${JSON.stringify(chunk)}\n\n`);
        };

        const ensureRoleSent = () => {
          if (!sentRole) {
            sentRole = true;
            sendChunk({ role: 'assistant' }, null);
          }
        };

        if (keepaliveMs > 0) {
          keepaliveTimer = setInterval(() => {
            safeEnqueue(': keepalive\n\n');
          }, keepaliveMs);
          keepaliveTimer.unref?.();
        }

        try {
          const result = await runWithRetry({
            payload,
            isAuto,
            signal,
            getOutputCommitState: () => ({ publishedBytes, toolCallCount }),
            onDelta: async (ev) => {
              if (!ev || typeof ev !== 'object') return;
              if (ev.reset && !emittedAny) return;
              if (typeof ev.content === 'string' && ev.content.length > 0) {
                ensureRoleSent();
                emittedAny = true;
                publishedBytes += Buffer.byteLength(ev.content, 'utf8');
                sendChunk({ content: ev.content }, null);
              }
              if (ev.call) {
                ensureRoleSent();
                emittedAny = true;
                const index = toolCallCount++;
                publishedBytes += Buffer.byteLength(JSON.stringify(ev.call), 'utf8');
                sendChunk({ tool_calls: [{ index, ...ev.call }] }, null);
              }
            },
          });

          ensureRoleSent();
          const finishReason = toolCallCount > 0 || result.calls?.length ? 'tool_calls' : 'stop';
          const annotations = result.annotations?.length ? toChatAnnotations(result.annotations) : null;
          sendChunk(annotations ? { annotations } : {}, finishReason);
          if (includeUsage) {
            const usage = estimateUsage({ promptChars, imageCount, outputBytes: publishedBytes });
            sendChunk({}, undefined, usage);
          }
          safeEnqueue('data: [DONE]\n\n');
        } catch (err) {
          if (
            !signal?.aborted &&
            err?.code === 'NATIVE_TURN_TIMEOUT' &&
            err?.unverifiedOutput !== true &&
            err?.postOutputIdleStall === true &&
            (publishedBytes > 0 || toolCallCount > 0)
          ) {
            ensureRoleSent();
            sendChunk({}, toolCallCount > 0 ? 'tool_calls' : 'stop');
            if (includeUsage) {
              const usage = estimateUsage({ promptChars, imageCount, outputBytes: publishedBytes });
              sendChunk({}, undefined, usage);
            }
            safeEnqueue('data: [DONE]\n\n');
          } else {
            safeEnqueue(
              `data: ${JSON.stringify({
                error: {
                  code: err?.code || 'UPSTREAM_ERROR',
                  message: err?.upstreamMessage || err?.message || 'Generation failed',
                },
                incomplete: true,
              })}\n\n`,
            );
            safeEnqueue('data: [DONE]\n\n');
          }
        } finally {
          safeClose();
        }
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
