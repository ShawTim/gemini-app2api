import fs from 'node:fs';
import path from 'node:path';
import { NativeDirectProvider } from '../../src/native-provider.mjs';
import { openDirectTurn as defaultOpenDirectTurn } from '../../src/gateway/native-transport.mjs';
import { MODEL_SPECS, canonicalModel } from '../../src/openai-contract.mjs';
import { decodeImageBytes, decodeImageDataUrl, MAX_IMAGE_BYTES } from '../../src/image-input.mjs';
import { createImageBlobCache } from '../../src/gateway/image-upload.mjs';
import { fetchGoogleUsageInfo as defaultFetchGoogleUsageInfo } from '../../src/gateway/quota-transport.mjs';
import { decodeUsageInfo as defaultDecodeUsageInfo } from '../../src/gateway/quota.mjs';
import { decodeSubscription as defaultDecodeSubscription } from '../../src/gateway/subscription.mjs';
import { formatQuotaDisplay, SUBSCRIPTION_LABELS } from '../pi/provider.js';
import { resolveGatewayConfig } from './auth.js';

const MAX_TOOL_IMAGES = 16;
const DEFAULT_TIMEOUT_MS = 180_000;
const ALLOWED_MODELS = Object.freeze(Object.keys(MODEL_SPECS));

const THINKING_LEVEL_MAP = Object.freeze({
  off: 0,
  none: 0,
  minimal: 0,
  low: 1,
  medium: 2,
  high: 2,
  xhigh: 2,
});

export const MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'ask_gemini',
    description:
      'Ask Google Gemini (512k context Gemini Neon / Hydrogen, Flash Lite, or Auto) for a second opinion, code/architecture review, long-document analysis, or multimodal image inspection.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: 'The prompt, question, or content to send to Gemini.',
        },
        system: {
          type: 'string',
          description: 'Optional system instructions to guide Gemini.',
        },
        model: {
          type: 'string',
          enum: [...ALLOWED_MODELS],
          description:
            'Model ID: gemini-neon (default, highest capability, 512k), gemini-hydrogen (fast, 512k), gemini-flash-lite (lightweight, 128k), or gemini-auto (dynamic routing / Free tier).',
        },
        thinking_level: {
          oneOf: [
            { type: 'integer', minimum: 0, maximum: 2 },
            { type: 'string', enum: ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'] },
          ],
          description: 'Thinking depth: 0/off/minimal, 1/low, or 2/medium/high (default: 2).',
        },
        images: {
          type: 'array',
          maxItems: MAX_TOOL_IMAGES,
          description: 'Optional images (up to 16 static PNG/JPEG/WebP files or data:image/... URLs).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: {
                type: 'string',
                description: 'Local file path to a static PNG, JPEG, or WebP image (up to 20 MiB).',
              },
              url: {
                type: 'string',
                description: 'Inline data:image/(png|jpeg|webp);base64,... URL.',
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'gemini_search',
    description:
      'Run a Google Search-grounded query through Gemini Neon (native_search) and return an answer with verified source citations.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Public web search question or topic (max ~16 KiB).',
        },
        system: {
          type: 'string',
          description: 'Optional formatting or conciseness instructions.',
        },
      },
    },
  },
  {
    name: 'gemini_quota',
    description:
      'Check your Google Gemini subscription tier (Free / AI Plus / AI Pro / AI Ultra) and current remaining quota windows.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
]);

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

function loadImageParts(images) {
  if (images === undefined) return [];
  if (!Array.isArray(images)) {
    throw Object.assign(new Error('`images` must be an array'), { code: 'INVALID_ARGUMENTS' });
  }
  if (images.length > MAX_TOOL_IMAGES) {
    throw Object.assign(new Error(`Too many images (max ${MAX_TOOL_IMAGES})`), { code: 'IMAGE_COUNT_EXCEEDED' });
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
    const resolved = path.resolve(item.path.trim());
    const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      throw Object.assign(new Error(`Image file not found or not a regular file: ${item.path}`), {
        code: 'INVALID_IMAGE_PATH',
      });
    }
    if (stat.size <= 0 || stat.size > MAX_IMAGE_BYTES) {
      throw Object.assign(new Error(`Image file size must be between 1 byte and ${MAX_IMAGE_BYTES} bytes`), {
        code: 'IMAGE_TOO_LARGE',
      });
    }
    const bytes = fs.readFileSync(resolved);
    const mimeType = detectImageMime(bytes, resolved);
    decodeImageBytes(bytes, mimeType);
    parts.push({
      type: 'image_url',
      image_url: { url: `data:${mimeType};base64,${bytes.toString('base64')}`, detail: 'auto' },
    });
  }
  return parts;
}

function normalizeThinkingLevel(raw) {
  if (raw === undefined || raw === null) return 2;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 2) return raw;
  if (typeof raw === 'string') {
    const key = raw.trim().toLowerCase();
    if (Object.hasOwn(THINKING_LEVEL_MAP, key)) return THINKING_LEVEL_MAP[key];
  }
  throw Object.assign(
    new Error('Invalid `thinking_level`: expected 0..2 or one of off, none, minimal, low, medium, high, xhigh'),
    { code: 'INVALID_THINKING_LEVEL' },
  );
}

function formatCitationsMarkdown(annotations) {
  if (!Array.isArray(annotations) || !annotations.length) return '';
  const seen = new Set();
  const lines = [];
  for (const item of annotations) {
    const citation = item?.url_citation ?? item;
    const url = typeof citation?.url === 'string' ? citation.url.trim() : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = typeof citation?.title === 'string' && citation.title.trim() ? citation.title.trim() : url;
    lines.push(`- [${title}](${url})`);
  }
  return lines.length ? `\n\n### Sources\n${lines.join('\n')}` : '';
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
  fetchGoogleUsageInfo = defaultFetchGoogleUsageInfo,
  decodeUsageInfo = defaultDecodeUsageInfo,
  decodeSubscription = defaultDecodeSubscription,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const imageBlobCache = createImageBlobCache();

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
    return {
      content: typeof msg?.content === 'string' ? msg.content : '',
      model: data?.model || payload.model,
      annotations: Array.isArray(msg?.annotations) ? msg.annotations : [],
      usage: data?.usage ?? null,
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
      };
    };

    try {
      return await invoke(cred.access);
    } catch (err) {
      if (err?.code === 'NATIVE_PERMISSION_OR_AUTH' && !signal?.aborted) {
        const refreshed = await authManager.getValidCredential({ signal, forceRefresh: true });
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
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw Object.assign(new Error('Invalid arguments object'), { code: 'INVALID_ARGUMENTS' });
    }
    const prompt = typeof args.prompt === 'string' ? args.prompt : '';
    if (!prompt.trim()) {
      throw Object.assign(new Error('`prompt` must be a non-empty string'), { code: 'INVALID_ARGUMENTS' });
    }
    const system = args.system === undefined ? '' : typeof args.system === 'string' ? args.system : null;
    if (system === null) {
      throw Object.assign(new Error('`system` must be a string'), { code: 'INVALID_ARGUMENTS' });
    }
    const rawModel = args.model === undefined ? 'gemini-neon' : args.model;
    if (typeof rawModel !== 'string') {
      throw Object.assign(new Error('`model` must be a string'), { code: 'UNSUPPORTED_MODEL' });
    }
    const model = canonicalModel(rawModel.trim());
    if (!ALLOWED_MODELS.includes(model)) {
      throw Object.assign(new Error(`Unsupported model "${rawModel}". Supported: ${ALLOWED_MODELS.join(', ')}`), {
        code: 'UNSUPPORTED_MODEL',
      });
    }
    const thinkingLevel = normalizeThinkingLevel(args.thinking_level);
    const imageParts = loadImageParts(args.images);
    const messages = [];
    if (system.trim()) messages.push({ role: 'system', content: system });
    messages.push({
      role: 'user',
      content: imageParts.length ? [{ type: 'text', text: prompt }, ...imageParts] : prompt,
    });

    const result = await executeChat(
      {
        model,
        messages,
        ...(model === 'gemini-auto' ? {} : { thinking_level: thinkingLevel }),
      },
      { signal },
    );
    const text = result.content || '(empty response)';
    return {
      content: [{ type: 'text', text }],
      _meta: {
        model: result.model,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.incomplete ? { incomplete: true } : {}),
      },
    };
  }

  async function handleGeminiSearch(args, { signal } = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw Object.assign(new Error('Invalid arguments object'), { code: 'INVALID_ARGUMENTS' });
    }
    const query = typeof args.query === 'string' ? args.query : '';
    if (!query.trim()) {
      throw Object.assign(new Error('`query` must be a non-empty string'), { code: 'INVALID_ARGUMENTS' });
    }
    const system = args.system === undefined ? '' : typeof args.system === 'string' ? args.system : null;
    if (system === null) {
      throw Object.assign(new Error('`system` must be a string'), { code: 'INVALID_ARGUMENTS' });
    }
    const messages = [];
    if (system.trim()) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: query });

    const result = await executeChat(
      {
        model: 'gemini-neon',
        thinking_level: 2,
        native_search: true,
        messages,
      },
      { signal },
    );
    const sourcesMd = formatCitationsMarkdown(result.annotations);
    const text = (result.content || '(empty response)') + sourcesMd;
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
    const cred = await authManager.getValidCredential({ signal });
    const fetchOnce = async (accessToken) => {
      const { payload } = await fetchGoogleUsageInfo(accessToken, { signal, timeoutMs: 10_000 });
      const usageInfo = decodeUsageInfo(payload);
      const subscriptionInfo = decodeSubscription(payload);
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
    tools: MCP_TOOL_DEFINITIONS,
    callTool,
    handleAskGemini,
    handleGeminiSearch,
    handleGeminiQuota,
  };
}
