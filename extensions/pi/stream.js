import { openDirectTurn as defaultOpenDirectTurn } from '../../src/gateway/native-transport.mjs';
import { createImageBlobCache } from '../../src/gateway/image-upload.mjs';
import { NativeDirectProvider as DefaultNativeDirectProvider } from '../../src/native-provider.mjs';
import { automaticRecoveryKind as defaultAutomaticRecoveryKind } from '../../src/gateway/automatic-recovery.mjs';
import { buildChatPayload as defaultBuildChatPayload } from './transcript.js';
import { estimateUsage as defaultEstimateUsage } from '../../src/openai-usage.mjs';

const PREFIX_BYTES = 2048;

const ALLOWED_RECOVERY_KINDS = new Set([
  'transport',
  'tool_protocol',
  'structured_output',
  'incomplete_response',
  'provider_soft_error',
]);

const GENERIC_PROTOCOL_MESSAGES = new Set([
  'Native response failed verification',
  'Unsupported or invalid request',
]);

function formatFriendlyError(error, isAborted, modelId) {
  if (isAborted) return 'Request was aborted';
  if (
    error?.status === 429 ||
    error?.code === 'NATIVE_RATE_LIMITED' ||
    error?.code === 'NATIVE_QUOTA_EXHAUSTED' ||
    error?.code === 'NATIVE_QUOTA_INSUFFICIENT'
  ) {
    return 'Google Gemini quota exhausted for this account. Please wait for your usage window to reset or try gemini-hydrogen.';
  }
  if (
    error?.status === 413 ||
    error?.code === 'PROMPT_TOO_LARGE' ||
    error?.code === 'REQUEST_TOO_LARGE'
  ) {
    return '413 request_too_large: Prompt exceeds the context window.';
  }
  if (
    error?.status === 401 ||
    error?.status === 403 ||
    error?.code === 'NATIVE_PERMISSION_OR_AUTH' ||
    error?.code === 'ACCOUNT_LOGIN_REQUIRED' ||
    error?.code === 'OAUTH_REFRESH_FAILED' ||
    error?.code === 'INVALID_TOKEN' ||
    error?.code === 'NATIVE_CREDENTIAL_REQUIRED'
  ) {
    return `Google Gemini authentication expired or permission denied${error?.code ? ` (${error.code})` : ''}. Please run /login gemini-app to sign in again.`;
  }
  const upstreamMessage =
    typeof error?.nativeEvidence?.upstreamMessage === 'string' &&
    error.nativeEvidence.upstreamMessage.length > 0
      ? error.nativeEvidence.upstreamMessage
      : '';
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : '';
  if (code === 'NATIVE_PRECONDITION_REQUIRED') {
    if (/terms of service|tos_not_accepted/i.test(upstreamMessage)) {
      return `Google Gemini Terms of Service not accepted [NATIVE_PRECONDITION_REQUIRED]: ${upstreamMessage} — Accept Terms of Service at https://gemini.google.com or run /login gemini-app again.`;
    }
    if (/requires_advanced|mismatched_bard_mode|invalid_bard_mode/i.test(upstreamMessage)) {
      return `Selected model (${modelId || 'requested mode'}) requires a paid Google AI subscription [NATIVE_PRECONDITION_REQUIRED]: ${upstreamMessage} — Switch to gemini-auto (or run /login gemini-app to refresh available models).`;
    }
    return `Native response failed verification: [NATIVE_PRECONDITION_REQUIRED]${upstreamMessage ? ` — ${upstreamMessage}` : ''}. Free Gemini accounts only support gemini-auto (switch to gemini-auto or run /login gemini-app; if new to Gemini, ensure Terms of Service are accepted at https://gemini.google.com).`;
  }
  if (code === 'MODEL_DOWNGRADE_REJECTED') {
    return `Requested model (${modelId || 'selected model'}) was downgraded or is unavailable for this account [MODEL_DOWNGRADE_REJECTED]. Try gemini-hydrogen, or switch to gemini-auto on Free accounts.`;
  }
  const param = typeof error?.param === 'string' && error.param.length > 0 ? ` (param: ${error.param})` : '';
  const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : '';
  if (code && (!message || GENERIC_PROTOCOL_MESSAGES.has(message))) {
    return `${message ? `${message}: ` : ''}[${code}]${param}${upstreamMessage ? ` — ${upstreamMessage}` : ''}`;
  }
  if (code && !message.includes(code)) {
    return `[${code}] ${message}${param}${upstreamMessage ? ` — ${upstreamMessage}` : ''}`;
  }
  return message ? `${message}${param}${upstreamMessage ? ` — ${upstreamMessage}` : ''}` : code || 'Unknown error';
}

function hasTrailingHighSurrogate(str) {
  if (!str || typeof str !== 'string') return false;
  const code = str.charCodeAt(str.length - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

function splitCompleteCodePoints(str) {
  if (!str) return { ready: '', trailing: '' };
  if (hasTrailingHighSurrogate(str)) {
    const head = str.slice(0, -1);
    return {
      ready: head.isWellFormed() ? head : head.toWellFormed(),
      trailing: str.slice(-1),
    };
  }
  return {
    ready: str.isWellFormed() ? str : str.toWellFormed(),
    trailing: '',
  };
}

function contentChars(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n, p) => n + (typeof p?.text === 'string' ? p.text.length : 0), 0);
  }
  return 0;
}

class DefaultAssistantMessageEventStream {
  #queue = [];
  #waiting = [];
  #done = false;
  #startedAt = Date.now();
  #startedAtMonotonic = performance.now();
  #finalResultPromise;
  #resolveFinalResult;

  constructor() {
    this.#finalResultPromise = new Promise((resolve) => {
      this.#resolveFinalResult = resolve;
    });
  }

  #time(message) {
    if (
      this.#done ||
      !message ||
      typeof message !== 'object' ||
      message.durationMs !== undefined ||
      message.timestamp < this.#startedAt
    ) {
      return;
    }
    message.durationMs = Math.max(0, Math.round(performance.now() - this.#startedAtMonotonic));
  }

  push(event) {
    if (this.#done) return;
    if (event?.type === 'done') {
      this.#time(event.message);
      this.#done = true;
      this.#resolveFinalResult(event.message);
    } else if (event?.type === 'error') {
      this.#time(event.error);
      this.#done = true;
      this.#resolveFinalResult(event.error);
    }
    const waiter = this.#waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.#queue.push(event);
    }
  }

  end(result) {
    if (result !== undefined) {
      this.#time(result);
      this.#done = true;
      this.#resolveFinalResult(result);
    } else {
      this.#done = true;
    }
    while (this.#waiting.length > 0) {
      const waiter = this.#waiting.shift();
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.#queue.length > 0) {
        yield this.#queue.shift();
      } else if (this.#done) {
        return;
      } else {
        const next = await new Promise((resolve) => this.#waiting.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }

  result() {
    return this.#finalResultPromise;
  }
}

export function defaultCreateAssistantMessageEventStream() {
  return new DefaultAssistantMessageEventStream();
}

export function createGeminiStreamHandler({
  createAssistantMessageEventStream = defaultCreateAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  toToolDeclaration,
  openTurn = defaultOpenDirectTurn,
  NativeDirectProvider = DefaultNativeDirectProvider,
  automaticRecoveryKind = defaultAutomaticRecoveryKind,
  buildChatPayload = defaultBuildChatPayload,
  estimateUsage = defaultEstimateUsage,
  resolveAccessToken,
} = {}) {
  if (typeof createAssistantMessageEventStream !== 'function') {
    throw new TypeError('createAssistantMessageEventStream is required');
  }
  const sharedBlobCache = createImageBlobCache();

  function executeStream(model, context, options = {}, { simple = false } = {}) {
    const stream = createAssistantMessageEventStream();

    (async () => {
      const partial = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'pending',
        timestamp: Date.now(),
      };

      let started = false;
      let textBuffer = '';
      let pendingSurrogate = '';
      let publishedBytes = 0;
      let toolCallCount = 0;
      let textBlock = null;
      let observedThinking = null;
      let hasToolCalls = false;

      let promptChars = 0;

      function ensureTextBlock() {
        if (!textBlock) {
          textBlock = { type: 'text', text: '' };
          partial.content.push(textBlock);
          const contentIndex = partial.content.length - 1;
          stream.push({ type: 'text_start', contentIndex, partial });
        }
        return textBlock;
      }

      function emitRawText(delta) {
        if (!delta) return;
        const block = ensureTextBlock();
        block.text += delta;
        publishedBytes += Buffer.byteLength(delta, 'utf8');
        const contentIndex = partial.content.indexOf(block);
        stream.push({
          type: 'text_delta',
          contentIndex,
          delta,
          partial,
        });
      }

      function endTextBlock({ flushPending = true } = {}) {
        if (pendingSurrogate) {
          pendingSurrogate = '';
          if (flushPending) {
            emitRawText('\uFFFD');
          }
        }
        if (textBlock) {
          const contentIndex = partial.content.indexOf(textBlock);
          if (contentIndex !== -1) {
            stream.push({
              type: 'text_end',
              contentIndex,
              content: textBlock.text,
              partial,
            });
          }
          textBlock = null;
        }
      }

      function emitText(delta) {
        if (!delta) return;
        const combined = pendingSurrogate + delta;
        const { ready, trailing } = splitCompleteCodePoints(combined);
        pendingSurrogate = trailing;
        if (ready) {
          emitRawText(ready);
        }
      }

      async function startOutput({ flushAll = false } = {}) {
        if (!started) {
          await options?.onResponse?.({ status: 200, headers: {} }, model);
          started = true;
          stream.push({ type: 'start', partial });
        }
        if (textBuffer.length > 0) {
          const toFlush = textBuffer;
          textBuffer = '';
          emitText(toFlush);
        }
        if (flushAll && pendingSurrogate) {
          pendingSurrogate = '';
          emitRawText('\uFFFD');
        }
      }

      const getOutputCommitState = () => ({
        publishedBytes: started ? publishedBytes : 0,
        toolCallCount: started ? toolCallCount : 0,
      });

      try {
        if (typeof resolveAccessToken !== 'function' && !options?.apiKey) {
          throw new Error(
            `No access token for provider ${model.provider}. Run /login gemini-app to sign in.`,
          );
        }

        let body;
        let codec;
        ({ payload: body, codec } = await buildChatPayload(model, context, options, {
          getCurrentSystemPrompt,
          getCurrentTools,
          toToolDeclaration,
          simple,
        }));
        promptChars = Array.isArray(body?.messages)
          ? body.messages.reduce((n, m) => n + contentChars(m?.content), 0)
          : 0;

        const authManager = {
          getValidAccessToken: async () => {
            if (typeof resolveAccessToken === 'function') {
              const token = await resolveAccessToken({
                signal: options?.signal,
                apiKey: options?.apiKey,
                model,
              });
              if (!token) {
                throw new Error(
                  `No access token for provider ${model.provider}. Sign in with OAuth first.`,
                );
              }
              return token;
            }
            return options.apiKey;
          },
        };
        const provider = new NativeDirectProvider(authManager, {
          openTurn,
          blobCache: sharedBlobCache,
          modelAlias: model.id,
          allowAutoModel: true,
        });

        let attempts = 0;
        let recoveryCode;

        while (true) {
          try {
            const onDelta = async (event) => {
              await options?.onProviderStreamEvent?.(event, model);
              if (!event || typeof event !== 'object') return;

              if (event.reset) {
                if (!started) {
                  textBuffer = '';
                  return;
                }
                throw Object.assign(
                  new Error('Upstream stream reset after output already started'),
                  { code: 'NON_MONOTONIC_NATIVE_RESPONSE' },
                );
              }

              if (event.response?.thinkingLevel !== undefined && event.response.thinkingLevel !== null) {
                observedThinking = event.response.thinkingLevel;
              }
              if (event.response?.id && !partial.responseId) {
                partial.responseId = event.response.id;
              }

              if (typeof event.content === 'string' && event.content.length > 0) {
                if (started) {
                  emitText(event.content);
                } else {
                  textBuffer += event.content;
                  const { ready } = splitCompleteCodePoints(textBuffer);
                  if (Buffer.byteLength(ready, 'utf8') >= PREFIX_BYTES) {
                    await startOutput({ flushAll: false });
                  }
                }
              }

              if (event.call) {
                await startOutput({ flushAll: true });
                endTextBlock();
                hasToolCalls = true;
                toolCallCount++;

                const originalName = codec.decodeToolName(event.call.function.name);
                const originalId = codec.decodeToolCallId(event.call.id);
                let parsedArgs = {};
                try {
                  parsedArgs = JSON.parse(event.call.function.arguments);
                } catch {
                  parsedArgs = {};
                }

                const toolBlock = {
                  type: 'toolCall',
                  id: originalId,
                  name: originalName,
                  arguments: parsedArgs,
                };
                partial.content.push(toolBlock);
                const contentIndex = partial.content.length - 1;
                stream.push({ type: 'toolcall_start', contentIndex, partial });

                const argsDelta = event.call.function.arguments || '{}';
                stream.push({ type: 'toolcall_delta', contentIndex, delta: argsDelta, partial });
                publishedBytes += Buffer.byteLength(JSON.stringify(event.call), 'utf8');

                stream.push({ type: 'toolcall_end', contentIndex, toolCall: toolBlock, partial });
              }
            };

            const turnResult = await provider.runTurn('pi-session', body, onDelta, {
              incrementalOutput: true,
              signal: options?.signal,
              recoveryCode,
              getOutputCommitState,
            });
            if (turnResult?.thinkingLevel !== undefined && turnResult.thinkingLevel !== null) {
              observedThinking = turnResult.thinkingLevel;
            }
            if (turnResult?.id && !partial.responseId) {
              partial.responseId = turnResult.id;
            }
            break;
          } catch (turnError) {
            if (
              !started &&
              attempts === 0 &&
              !options?.signal?.aborted &&
              turnError?.code !== 'NATIVE_TURN_ABORTED' &&
              turnError?.code !== 'REQUEST_CANCELLED'
            ) {
              const kind = automaticRecoveryKind(turnError, model.id, { allowAutoModel: true });
              if (ALLOWED_RECOVERY_KINDS.has(kind)) {
                attempts++;
                recoveryCode = turnError.code;
                textBuffer = '';
                pendingSurrogate = '';
                observedThinking = null;
                delete partial.responseId;
                continue;
              }
            }
            throw turnError;
          }
        }

        await startOutput({ flushAll: true });
        endTextBlock();

        const est = estimateUsage({ promptChars, outputBytes: publishedBytes });
        partial.usage = {
          input: est.prompt_tokens,
          output: est.completion_tokens,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: est.total_tokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
        if (observedThinking !== null && observedThinking !== undefined) {
          partial.providerThinkingLevel = String(observedThinking);
        }
        partial.stopReason = hasToolCalls ? 'toolUse' : 'stop';
        stream.push({ type: 'done', reason: partial.stopReason, message: partial });
        stream.end();
      } catch (error) {
        endTextBlock({ flushPending: started });
        const isAborted =
          options?.signal?.aborted ||
          error?.code === 'NATIVE_TURN_ABORTED' ||
          error?.code === 'REQUEST_CANCELLED';
        const stopReason = isAborted ? 'aborted' : 'error';
        if (publishedBytes > 0 || promptChars > 0) {
          const est = estimateUsage({ promptChars, outputBytes: publishedBytes });
          partial.usage = {
            input: est.prompt_tokens,
            output: est.completion_tokens,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: est.total_tokens,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
        }
        partial.stopReason = stopReason;
        partial.errorMessage = formatFriendlyError(error, isAborted, model?.id);
        stream.push({ type: 'error', reason: stopReason, error: partial });
        stream.end();
      }
    })();

    return stream;
  }

  return {
    stream: (model, context, options) => executeStream(model, context, options, { simple: false }),
    streamSimple: (model, context, options) => executeStream(model, context, options, { simple: true }),
  };
}
