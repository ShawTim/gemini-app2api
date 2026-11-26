import fs from 'node:fs';
import path from 'node:path';
import { NativeDirectProvider } from '../../src/native-provider.mjs';
import { openDirectTurn as defaultOpenDirectTurn } from '../../src/gateway/native-transport.mjs';
import { MODEL_SPECS, NATIVE_MODELS } from '../../src/openai-contract.mjs';
import { decodeImageBytes, decodeImageDataUrl, MAX_IMAGE_BYTES } from '../../src/image-input.mjs';
import { createImageBlobCache } from '../../src/gateway/image-upload.mjs';
import { fetchGoogleUsageInfo as defaultFetchGoogleUsageInfo } from '../../src/gateway/quota-transport.mjs';
import { fetchGoogleSubscription as defaultFetchGoogleSubscription } from '../../src/gateway/subscription-transport.mjs';
import { decodeUsageInfo as defaultDecodeUsageInfo } from '../../src/gateway/quota.mjs';
import { decodeSubscription as defaultDecodeSubscription } from '../../src/gateway/subscription.mjs';
import {
  buildMcpToolDefinitions,
  normalizeAskGeminiArgs,
  normalizeGeminiSearchArgs,
  formatMcpCitationsMarkdown,
  MAX_MCP_TOOL_IMAGES,
} from '../../src/gateway/mcp-core.mjs';
import { formatQuotaDisplay, SUBSCRIPTION_LABELS } from '../pi/provider.js';
import { resolveGatewayConfig } from './auth.js';

const DEFAULT_TIMEOUT_MS = 180_000;
const STREAM_PREFIX_BYTES = 2048;
const MAX_SSE_LINE_BYTES = 4 * 1024 * 1024;
const ALLOWED_DIRECT_MODELS = Object.freeze(Object.keys(MODEL_SPECS));

function splitCompleteCodePoints(str) {
  if (!str) return { ready: '', trailing: '' };
  const last = str.charCodeAt(str.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
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

export const MCP_TOOL_DEFINITIONS = buildMcpToolDefinitions({
  allowLocalImagePaths: true,
  models: ALLOWED_DIRECT_MODELS,
});

function detectImageMime(bytes, filePath) {
  if (bytes.length >= 8 && bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  throw Object.assign(new Error('Unsupported image format; only static PNG, JPEG, and WebP are supported.'), {
    code: 'UNSUPPORTED_IMAGE_FORMAT',
  });
}

function readLocalImageBounded(filePath) {
  const resolved = path.resolve(filePath);
  // Use O_NONBLOCK alongside O_NOFOLLOW so a FIFO path cannot stall the event loop before fstatSync rejects it.
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
  let fd;
  try {
    fd = fs.openSync(resolved, flags);
  } catch (err) {
    throw Object.assign(new Error(`Image file not found or symlink refused: ${filePath}`), {
      code: 'INVALID_IMAGE_PATH',
      cause: err,
    });
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw Object.assign(new Error(`Image path is not a regular file: ${filePath}`), {
        code: 'INVALID_IMAGE_PATH',
      });
    }
    if (stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
      throw Object.assign(new Error(`Image file size must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`), {
        code: 'IMAGE_TOO_LARGE',
      });
    }
    // Bounded read directly from the validated fd to prevent TOCTOU swaps/growth.
    const chunks = [];
    let total = 0;
    const buf = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > MAX_IMAGE_BYTES) {
        throw Object.assign(new Error(`Image file exceeds maximum size (${MAX_IMAGE_BYTES} bytes)`), {
          code: 'IMAGE_TOO_LARGE',
        });
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    if (total === 0) {
      throw Object.assign(new Error('Image file is empty'), { code: 'INVALID_IMAGE_BYTES' });
    }
    return Buffer.concat(chunks, total);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
}

function loadLocalOrInlineImageParts(images) {
  if (images === undefined) return [];
  if (!Array.isArray(images)) {
    throw Object.assign(new Error('`images` must be an array'), { code: 'INVALID_ARGUMENTS' });
  }
  if (images.length > MAX_MCP_TOOL_IMAGES) {
    throw Object.assign(new Error(`Too many images (max ${MAX_MCP_TOOL_IMAGES})`), { code: 'IMAGE_COUNT_EXCEEDED' });
  }
  const parts = [];
  for (const item of images) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw Object.assign(new Error('Each image entry must be an object with `path` or `url`'), {
        code: 'INVALID_ARGUMENTS',
      });
    }
    const hasPath = typeof item.path === 'string' && item.path.trim().length > 0;
    const hasUrl = typeof item.url === 'string' && item.url.trim().length > 0;
    if (hasPath === hasUrl) {
      throw Object.assign(new Error('Each image entry must specify exactly one of `path` or `url`'), {
        code: 'INVALID_ARGUMENTS',
      });
    }
    if (hasUrl) {
      const decoded = decodeImageDataUrl(item.url.trim());
      parts.push({ type: 'image_url', image_url: { url: decoded.url, detail: 'auto' } });
      continue;
    }
    const bytes = readLocalImageBounded(item.path.trim());
    const mimeType = detectImageMime(bytes, item.path.trim());
    decodeImageBytes(bytes, mimeType);
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${bytes.toString('base64')}`, detail: 'auto' },
    });
  }
  return parts;
}

function formatFriendlyMcpError(err, loginCommand = 'npx mcp-gemini-app login') {
  const code = err?.code || '';
  if (code === 'MCP_AUTH_REQUIRED') {
    return err.message;
  }
  if (
    code === 'NATIVE_PERMISSION_OR_AUTH' ||
    code === 'NATIVE_AUTH_REJECTED' ||
    code === 'NATIVE_PERMISSION_REJECTED' ||
    code === 'OAUTH_REFRESH_FAILED' ||
    code === 'QUOTA_AUTH_REJECTED'
  ) {
    return `Google authentication failed (${code}). Run \`${loginCommand}\` to sign in again.`;
  }
  if (code === 'NATIVE_QUOTA_EXHAUSTED' || code === 'QUOTA_RATE_LIMITED') {
    return `Google Gemini quota exhausted or rate-limited (${code}). Try \`gemini-hydrogen\` or wait for quota reset.`;
  }
  if (code === 'NATIVE_PRECONDITION_REQUIRED' && err?.upstreamMessage) {
    return `Google rejected the request (${code}): ${err.upstreamMessage}`;
  }
  const msg = err?.message || String(err || 'Unknown error');
  return code && !msg.includes(code) ? `[${code}] ${msg}` : msg;
}

export function createMcpToolHandlers({
  authManager,
  env = process.env,
  clientLabel = 'mcp-gemini-app',
  loginCommand = 'npx mcp-gemini-app login',
  openTurn = defaultOpenDirectTurn,
  uploadImages,
  fetchImpl = globalThis.fetch,
  fetchGoogleUsageInfo,
  fetchGoogleSubscription,
  decodeUsageInfo = defaultDecodeUsageInfo,
  decodeSubscription = defaultDecodeSubscription,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const usageFetch = fetchGoogleUsageInfo || defaultFetchGoogleUsageInfo;
  const subFetch = fetchGoogleSubscription || (fetchGoogleUsageInfo ? null : defaultFetchGoogleSubscription);
  const imageBlobCache = createImageBlobCache();
  const initialGateway = resolveGatewayConfig(env);
  const tools = buildMcpToolDefinitions({
    allowLocalImagePaths: true,
    models: initialGateway ? NATIVE_MODELS : ALLOWED_DIRECT_MODELS,
  });

  function withOptionalTimeout(signal, reqTimeoutMs) {
    if (!(reqTimeoutMs > 0)) {
      return { signal, cleanup: () => {} };
    }
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort(signal?.reason ?? new Error('Request aborted'));
    if (signal?.aborted) onOuterAbort();
    else signal?.addEventListener('abort', onOuterAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(Object.assign(new Error('Gateway request timed out'), { code: 'REQUEST_TIMEOUT' })),
      reqTimeoutMs,
    );
    timer.unref?.();
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onOuterAbort);
      },
    };
  }

  async function callViaGateway(gateway, payload, { signal, onTextDelta, timeoutMs: reqTimeoutMs } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (gateway.apiKey) headers.Authorization = `Bearer ${gateway.apiKey}`;
    const wantStream = typeof onTextDelta === 'function' && !payload.native_search;
    if (wantStream) headers.Accept = 'text/event-stream, application/json';

    const scoped = withOptionalTimeout(signal, reqTimeoutMs);
    try {
      const res = await fetchImpl(`${gateway.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...payload, stream: wantStream }),
        signal: scoped.signal,
      });
      const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        const code = data?.error?.code || `GATEWAY_HTTP_${res.status}`;
        const message = data?.error?.message || `Gateway returned HTTP ${res.status}`;
        throw Object.assign(new Error(message), { code, status: res.status });
      }
      if (!wantStream || !contentType.includes('text/event-stream') || !res.body) {
        let data;
        try {
          data = await res.json();
        } catch (err) {
          if (scoped.signal?.aborted) {
            throw scoped.signal.reason instanceof Error
              ? scoped.signal.reason
              : Object.assign(new Error('Gateway request aborted'), { code: 'REQUEST_ABORTED', cause: err });
          }
          throw Object.assign(new Error('Invalid JSON response from gateway'), {
            code: 'INVALID_GATEWAY_RESPONSE',
            cause: err,
          });
        }
        if (
          !data ||
          typeof data !== 'object' ||
          Array.isArray(data) ||
          (!Array.isArray(data.choices) && !data.error && data.status !== 'incomplete' && data.incomplete !== true)
        ) {
          throw Object.assign(new Error('Unexpected JSON response shape from gateway'), {
            code: 'INVALID_GATEWAY_RESPONSE',
          });
        }
        const msg = data?.choices?.[0]?.message;
        const content = typeof msg?.content === 'string' ? msg.content : '';
        const incomplete = data?.incomplete === true || data?.status === 'incomplete' || Boolean(data?.error);
        let streamed = false;
        if (wantStream && !incomplete && content) {
          onTextDelta(content);
          streamed = true;
        }
        return {
          content,
          model: data?.model || payload.model,
          annotations: Array.isArray(msg?.annotations) ? msg.annotations : [],
          usage: data?.usage ?? null,
          incomplete,
          incompleteReason: data?.error?.code || data?.incomplete_details?.code || data?.incomplete_details?.reason || null,
          streamed,
        };
      }

      const decoder = new TextDecoder('utf-8', { fatal: false });
      let lineBuf = '';
      let pendingSurrogate = '';
      let content = '';
      let model = payload.model;
      let usage = null;
      let annotations = [];
      let incomplete = false;
      let incompleteReason = null;
      let sawDone = false;
      let sawTerminalFinish = false;
      let streamed = false;

      const emitChunk = (text) => {
        if (!text) return;
        content += text;
        const { ready, trailing } = splitCompleteCodePoints(pendingSurrogate + text);
        pendingSurrogate = trailing;
        if (ready) {
          onTextDelta(ready);
          streamed = true;
        }
      };

      const processLine = (rawLine) => {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (Buffer.byteLength(line, 'utf8') > MAX_SSE_LINE_BYTES) {
          throw Object.assign(new Error('Gateway SSE line exceeded maximum size'), { code: 'GATEWAY_SSE_OVERFLOW' });
        }
        if (!line || line.startsWith(':')) return;
        if (!line.startsWith('data:')) return;
        const dataStr = line.slice(5).trim();
        if (!dataStr) return;
        if (dataStr === '[DONE]') {
          sawDone = true;
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(dataStr);
        } catch (err) {
          throw Object.assign(new Error('Malformed JSON in gateway SSE frame'), {
            code: 'INVALID_GATEWAY_SSE',
            cause: err,
          });
        }
        if (parsed?.model) model = parsed.model;
        if (parsed?.usage) usage = parsed.usage;
        if (parsed?.error) {
          incomplete = true;
          incompleteReason = parsed.error.code || parsed.error.message || 'upstream_error';
          return;
        }
        if (parsed?.incomplete === true || parsed?.status === 'incomplete') {
          incomplete = true;
          incompleteReason =
            parsed?.incomplete_details?.code || parsed?.incomplete_details?.reason || incompleteReason || 'incomplete';
        }
        const choice = parsed?.choices?.[0];
        if (choice?.delta?.content && typeof choice.delta.content === 'string') {
          emitChunk(choice.delta.content);
        }
        if (Array.isArray(choice?.delta?.annotations) && choice.delta.annotations.length) {
          annotations = choice.delta.annotations;
        } else if (Array.isArray(choice?.message?.annotations) && choice.message.annotations.length) {
          annotations = choice.message.annotations;
        }
        if (choice?.finish_reason === 'stop' || choice?.finish_reason === 'length') {
          sawTerminalFinish = true;
        } else if (choice?.finish_reason === 'error') {
          incomplete = true;
          incompleteReason = incompleteReason || 'stream_error';
        }
      };

      for await (const rawChunk of res.body) {
        const text = typeof rawChunk === 'string' ? rawChunk : decoder.decode(rawChunk, { stream: true });
        lineBuf += text;
        let nl;
        while ((nl = lineBuf.indexOf('\n')) !== -1) {
          processLine(lineBuf.slice(0, nl));
          lineBuf = lineBuf.slice(nl + 1);
          if (sawDone) break;
        }
        if (sawDone) break;
        if (Buffer.byteLength(lineBuf, 'utf8') > MAX_SSE_LINE_BYTES) {
          throw Object.assign(new Error('Gateway SSE line exceeded maximum size'), { code: 'GATEWAY_SSE_OVERFLOW' });
        }
      }
      const tail = decoder.decode();
      if (tail) lineBuf += tail;
      if (lineBuf && !sawDone) processLine(lineBuf);
      if (pendingSurrogate) {
        onTextDelta('\uFFFD');
        streamed = true;
        pendingSurrogate = '';
      }
      if (!sawDone && !sawTerminalFinish && !incomplete) {
        incomplete = true;
        incompleteReason = 'stream_truncated';
      }
      return {
        content,
        model,
        annotations,
        usage,
        incomplete,
        incompleteReason,
        streamed,
      };
    } finally {
      scoped.cleanup();
    }
  }

  async function callDirectNative(payload, { signal, onTextDelta, timeoutMs: reqTimeoutMs } = {}) {
    const cred = await authManager.getValidCredential({ signal });
    const tier = cred.subscriptionTier;
    const requestedModel = payload.model;
    const effectiveModel = !payload.native_search && tier === 'free' ? 'gemini-auto' : requestedModel;
    const effectivePayload = {
      ...payload,
      model: effectiveModel,
    };
    if (effectiveModel === 'gemini-auto') delete effectivePayload.thinking_level;
    const effectiveTimeout = reqTimeoutMs ?? timeoutMs;
    const wantStream = typeof onTextDelta === 'function' && !effectivePayload.native_search;
    let publishedToCallback = false;

    const invoke = async (accessToken) => {
      let textBuffer = '';
      let pendingSurrogate = '';
      let committed = false;
      let publishedBytes = 0;

      const emitReady = (delta) => {
        if (!delta) return;
        const { ready, trailing } = splitCompleteCodePoints(pendingSurrogate + delta);
        pendingSurrogate = trailing;
        if (ready) {
          onTextDelta(ready);
          publishedBytes += Buffer.byteLength(ready, 'utf8');
          publishedToCallback = true;
        }
      };

      const onDelta = wantStream
        ? (event) => {
            if (!event || typeof event !== 'object') return;
            if (event.reset) {
              if (!committed) {
                textBuffer = '';
                pendingSurrogate = '';
                return;
              }
              throw Object.assign(
                new Error('Upstream stream reset after output already started'),
                { code: 'NON_MONOTONIC_NATIVE_RESPONSE' },
              );
            }
            if (typeof event.content === 'string' && event.content.length > 0) {
              if (committed) {
                emitReady(event.content);
              } else {
                textBuffer += event.content;
                const { ready } = splitCompleteCodePoints(textBuffer);
                if (Buffer.byteLength(ready, 'utf8') >= STREAM_PREFIX_BYTES) {
                  committed = true;
                  const toFlush = textBuffer;
                  textBuffer = '';
                  emitReady(toFlush);
                }
              }
            }
          }
        : () => {};

      const provider = new NativeDirectProvider(
        { getValidAccessToken: async () => accessToken },
        {
          openTurn,
          ...(uploadImages ? { uploadImages } : {}),
          blobCache: imageBlobCache,
          modelAlias: effectiveModel,
          allowAutoModel: effectiveModel === 'gemini-auto',
          timeoutMs: effectiveTimeout,
        },
      );
      const turnResult = await provider.runTurn(clientLabel, effectivePayload, onDelta, {
        incrementalOutput: wantStream,
        ...(wantStream
          ? {
              getOutputCommitState: () => ({
                publishedBytes: committed ? publishedBytes : 0,
                toolCallCount: 0,
              }),
            }
          : {}),
        signal,
        timeoutMs: effectiveTimeout,
      });
      const content = typeof turnResult?.content === 'string' ? turnResult.content : '';
      const incomplete = Boolean(turnResult?.incomplete);
      if (wantStream && !incomplete) {
        if (textBuffer.length > 0) {
          committed = true;
          const toFlush = textBuffer;
          textBuffer = '';
          emitReady(toFlush);
        } else if (!committed && !publishedToCallback && content.length > 0) {
          committed = true;
          emitReady(content);
        }
        if (pendingSurrogate) {
          onTextDelta('\uFFFD');
          publishedBytes += Buffer.byteLength('\uFFFD', 'utf8');
          publishedToCallback = true;
          pendingSurrogate = '';
        }
      }
      return {
        content,
        model: turnResult?.model || effectiveModel,
        annotations: Array.isArray(turnResult?.annotations) ? turnResult.annotations : [],
        usage: turnResult?.usage ?? null,
        incomplete,
        incompleteReason: turnResult?.outputError?.code || turnResult?.incompleteDetails?.reason || null,
        streamed: publishedToCallback,
      };
    };

    try {
      return await invoke(cred.access);
    } catch (err) {
      if (
        !publishedToCallback &&
        (err?.code === 'NATIVE_PERMISSION_OR_AUTH' ||
          err?.code === 'NATIVE_AUTH_REJECTED' ||
          err?.code === 'NATIVE_PERMISSION_REJECTED') &&
        !signal?.aborted
      ) {
        // Pin retry strictly to the original request's account epoch so switching accounts
        // between attempt 1 and retry can never send Account A's prompt/images to Account B.
        const refreshed = await authManager.getValidCredential({
          signal,
          forceRefresh: true,
          ...(cred.accountEpoch !== undefined ? { expectedAccountEpoch: cred.accountEpoch } : {}),
        });
        return await invoke(refreshed.access);
      }
      throw err;
    }
  }

  async function executeChat(payload, { signal, onTextDelta, timeoutMs: reqTimeoutMs } = {}) {
    const gateway = resolveGatewayConfig(env);
    if (gateway) return callViaGateway(gateway, payload, { signal, onTextDelta, timeoutMs: reqTimeoutMs });
    return callDirectNative(payload, { signal, onTextDelta, timeoutMs: reqTimeoutMs });
  }

  async function runAskGemini(args, { signal, onTextDelta, timeoutMs: reqTimeoutMs } = {}) {
    const gateway = resolveGatewayConfig(env);
    const payload = normalizeAskGeminiArgs(args, {
      allowedModels: gateway ? NATIVE_MODELS : ALLOWED_DIRECT_MODELS,
      loadImages: loadLocalOrInlineImageParts,
    });
    return executeChat(payload, { signal, onTextDelta, timeoutMs: reqTimeoutMs });
  }

  async function runGeminiSearch(args, { signal, timeoutMs: reqTimeoutMs } = {}) {
    const payload = normalizeGeminiSearchArgs(args);
    return executeChat(payload, { signal, timeoutMs: reqTimeoutMs });
  }

  async function handleAskGemini(args, { signal } = {}) {
    const result = await runAskGemini(args, { signal });
    const text = result.content || '(empty response)';
    if (result.incomplete) {
      return {
        isError: true,
        content: [{ type: 'text', text: `[INCOMPLETE${result.incompleteReason ? `: ${result.incompleteReason}` : ''}] ${text}` }],
        _meta: { model: result.model, incomplete: true, ...(result.usage ? { usage: result.usage } : {}) },
      };
    }
    return {
      content: [{ type: 'text', text }],
      _meta: {
        model: result.model,
        ...(result.usage ? { usage: result.usage } : {}),
      },
    };
  }

  async function handleGeminiSearch(args, { signal } = {}) {
    const result = await runGeminiSearch(args, { signal });
    const sourcesMd = formatMcpCitationsMarkdown(result.annotations);
    const text = (result.content || '(empty response)') + sourcesMd;
    if (result.incomplete) {
      return {
        isError: true,
        content: [{ type: 'text', text: `[INCOMPLETE${result.incompleteReason ? `: ${result.incompleteReason}` : ''}] ${text}` }],
        _meta: { model: result.model, incomplete: true, citations: result.annotations.length },
      };
    }
    return {
      content: [{ type: 'text', text }],
      _meta: {
        model: result.model,
        citations: result.annotations.length,
        ...(result.usage ? { usage: result.usage } : {}),
      },
    };
  }

  async function handleGeminiQuota(_args, { signal, timeoutMs: reqTimeoutMs } = {}) {
    const gateway = resolveGatewayConfig(env);
    if (gateway) {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      if (gateway.apiKey) headers.Authorization = `Bearer ${gateway.apiKey}`;
      const scoped = withOptionalTimeout(signal, reqTimeoutMs);
      try {
        const res = await fetchImpl(`${gateway.baseUrl}/mcp`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'gemini_quota', arguments: {} },
          }),
          signal: scoped.signal,
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || data?.error) {
          const msg = data?.error?.message || `Gateway /mcp returned HTTP ${res.status}`;
          throw Object.assign(new Error(msg), { code: `GATEWAY_HTTP_${res.status}` });
        }
        if (data?.result?.content) return data.result;
        throw Object.assign(new Error('Invalid gateway /mcp quota response'), { code: 'INVALID_GATEWAY_RESPONSE' });
      } finally {
        scoped.cleanup();
      }
    }

    const quotaTimeoutMs = reqTimeoutMs ?? 10_000;
    const cred = await authManager.getValidCredential({ signal });
    const fetchSubOnly = async (accessToken) => {
      if (!subFetch) return { subscriptionInfo: null, subAuthRejected: false };
      try {
        const res = await subFetch(accessToken, { signal, timeoutMs: quotaTimeoutMs });
        if (res?.payload) {
          try {
            return { subscriptionInfo: decodeSubscription(res.payload), subAuthRejected: false };
          } catch {}
        }
        return { subscriptionInfo: null, subAuthRejected: false };
      } catch (err) {
        if (signal?.aborted) throw err;
        return { subscriptionInfo: null, subAuthRejected: err?.code === 'SUBSCRIPTION_AUTH_REJECTED' };
      }
    };
    const fetchOnce = async (accessToken) => {
      const [usageResult, subOutcome] = await Promise.all([
        usageFetch(accessToken, { signal, timeoutMs: quotaTimeoutMs }).then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error }),
        ),
        fetchSubOnly(accessToken),
      ]);
      if (!usageResult.ok) throw usageResult.error;
      const usageInfo = decodeUsageInfo(usageResult.value.payload);
      return { usageInfo, subscriptionInfo: subOutcome.subscriptionInfo, subAuthRejected: subOutcome.subAuthRejected };
    };
    let quota;
    let refreshedOnce = false;
    try {
      quota = await fetchOnce(cred.access);
    } catch (err) {
      if (err?.code === 'QUOTA_AUTH_REJECTED' && !signal?.aborted) {
        refreshedOnce = true;
        const refreshed = await authManager.getValidCredential({ signal, forceRefresh: true });
        quota = await fetchOnce(refreshed.access);
      } else {
        throw err;
      }
    }
    if (quota.subAuthRejected && !refreshedOnce && !signal?.aborted) {
      const refreshed = await authManager.getValidCredential({ signal, forceRefresh: true });
      const retrySub = await fetchSubOnly(refreshed.access);
      quota = { ...quota, subscriptionInfo: retrySub.subscriptionInfo };
    }
    const tierLabel = SUBSCRIPTION_LABELS[quota.subscriptionInfo?.tier] || quota.subscriptionInfo?.tier || 'Unknown';
    const text = formatQuotaDisplay(quota.usageInfo, quota.subscriptionInfo);
    return {
      content: [{ type: 'text', text }],
      _meta: {
        subscriptionTier: quota.subscriptionInfo?.tier || 'unknown',
        tierLabel,
      },
    };
  }

  async function callTool(name, args, { signal } = {}) {
    try {
      if (name === 'ask_gemini') return await handleAskGemini(args, { signal });
      if (name === 'gemini_search') return await handleGeminiSearch(args, { signal });
      if (name === 'gemini_quota') return await handleGeminiQuota(args, { signal });
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: formatFriendlyMcpError(err, loginCommand) }],
      };
    }
  }

  return {
    tools,
    callTool,
    runAskGemini,
    runGeminiSearch,
    handleAskGemini,
    handleGeminiSearch,
    handleGeminiQuota,
    formatError: (err) => formatFriendlyMcpError(err, loginCommand),
  };
}
