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
const ALLOWED_DIRECT_MODELS = Object.freeze(Object.keys(MODEL_SPECS));

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

function formatFriendlyMcpError(err) {
  const code = err?.code || '';
  if (code === 'MCP_AUTH_REQUIRED') {
    return err.message;
  }
  if (code === 'NATIVE_PERMISSION_OR_AUTH' || code === 'OAUTH_REFRESH_FAILED' || code === 'QUOTA_AUTH_REJECTED') {
    return `Google authentication failed (${code}). Run \`npx mcp-gemini-app login\` to sign in again.`;
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

  async function callViaGateway(gateway, payload, { signal } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (gateway.apiKey) headers.Authorization = `Bearer ${gateway.apiKey}`;
    const res = await fetchImpl(`${gateway.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...payload, stream: false }),
      signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const code = data?.error?.code || `GATEWAY_HTTP_${res.status}`;
      const message = data?.error?.message || `Gateway returned HTTP ${res.status}`;
      throw Object.assign(new Error(message), { code, status: res.status });
    }
    const msg = data?.choices?.[0]?.message;
    const incomplete = data?.status === 'incomplete' || Boolean(data?.error);
    return {
      content: typeof msg?.content === 'string' ? msg.content : '',
      model: data?.model || payload.model,
      annotations: Array.isArray(msg?.annotations) ? msg.annotations : [],
      usage: data?.usage ?? null,
      incomplete,
      incompleteReason: data?.error?.code || data?.incomplete_details?.reason || null,
    };
  }

  async function callDirectNative(payload, { signal } = {}) {
    const cred = await authManager.getValidCredential({ signal });
    const tier = cred.subscriptionTier;
    const requestedModel = payload.model;
    const effectiveModel = !payload.native_search && tier === 'free' ? 'gemini-auto' : requestedModel;
    const effectivePayload = {
      ...payload,
      model: effectiveModel,
    };
    if (effectiveModel === 'gemini-auto') delete effectivePayload.thinking_level;

    const invoke = async (accessToken) => {
      const provider = new NativeDirectProvider(
        { getValidAccessToken: async () => accessToken },
        {
          openTurn,
          ...(uploadImages ? { uploadImages } : {}),
          blobCache: imageBlobCache,
          modelAlias: effectiveModel,
          allowAutoModel: effectiveModel === 'gemini-auto',
          timeoutMs,
        },
      );
      const turnResult = await provider.runTurn('mcp-gemini-app', effectivePayload, () => {}, {
        signal,
        timeoutMs,
      });
      return {
        content: typeof turnResult?.content === 'string' ? turnResult.content : '',
        model: turnResult?.model || effectiveModel,
        annotations: Array.isArray(turnResult?.annotations) ? turnResult.annotations : [],
        usage: turnResult?.usage ?? null,
        incomplete: Boolean(turnResult?.incomplete),
        incompleteReason: turnResult?.outputError?.code || turnResult?.incompleteDetails?.reason || null,
      };
    };

    try {
      return await invoke(cred.access);
    } catch (err) {
      if ((err?.code === 'NATIVE_PERMISSION_OR_AUTH' || err?.code === 'NATIVE_AUTH_REJECTED') && !signal?.aborted) {
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

  async function executeChat(payload, { signal } = {}) {
    const gateway = resolveGatewayConfig(env);
    if (gateway) return callViaGateway(gateway, payload, { signal });
    return callDirectNative(payload, { signal });
  }

  async function handleAskGemini(args, { signal } = {}) {
    const gateway = resolveGatewayConfig(env);
    const payload = normalizeAskGeminiArgs(args, {
      allowedModels: gateway ? NATIVE_MODELS : ALLOWED_DIRECT_MODELS,
      loadImages: loadLocalOrInlineImageParts,
    });
    const result = await executeChat(payload, { signal });
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
    const payload = normalizeGeminiSearchArgs(args);
    const result = await executeChat(payload, { signal });
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

  async function handleGeminiQuota(_args, { signal } = {}) {
    const gateway = resolveGatewayConfig(env);
    if (gateway) {
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      };
      if (gateway.apiKey) headers.Authorization = `Bearer ${gateway.apiKey}`;
      const res = await fetchImpl(`${gateway.baseUrl}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'gemini_quota', arguments: {} },
        }),
        signal,
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.error) {
        const msg = data?.error?.message || `Gateway /mcp returned HTTP ${res.status}`;
        throw Object.assign(new Error(msg), { code: `GATEWAY_HTTP_${res.status}` });
      }
      if (data?.result?.content) return data.result;
      throw Object.assign(new Error('Invalid gateway /mcp quota response'), { code: 'INVALID_GATEWAY_RESPONSE' });
    }

    const cred = await authManager.getValidCredential({ signal });
    const fetchOnce = async (accessToken) => {
      const [usageRes, subRes] = await Promise.all([
        usageFetch(accessToken, { signal, timeoutMs: 10_000 }),
        subFetch ? subFetch(accessToken, { signal, timeoutMs: 10_000 }).catch(() => null) : Promise.resolve(null),
      ]);
      const usageInfo = decodeUsageInfo(usageRes.payload);
      let subscriptionInfo = null;
      try {
        const subPayload = subFetch ? subRes?.payload : usageRes.payload;
        if (subPayload) subscriptionInfo = decodeSubscription(subPayload);
      } catch {}
      return { usageInfo, subscriptionInfo };
    };
    let quota;
    try {
      quota = await fetchOnce(cred.access);
    } catch (err) {
      if (err?.code === 'QUOTA_AUTH_REJECTED' && !signal?.aborted) {
        const refreshed = await authManager.getValidCredential({ signal, forceRefresh: true });
        quota = await fetchOnce(refreshed.access);
      } else {
        throw err;
      }
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
        content: [{ type: 'text', text: formatFriendlyMcpError(err) }],
      };
    }
  }

  return {
    tools,
    callTool,
    handleAskGemini,
    handleGeminiSearch,
    handleGeminiQuota,
  };
}
