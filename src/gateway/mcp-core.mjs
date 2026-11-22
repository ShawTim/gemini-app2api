import { EventEmitter } from 'node:events';
import { MODEL_SPECS, canonicalModel } from '../openai-contract.mjs';
import { decodeImageDataUrl } from '../image-input.mjs';

export const SUPPORTED_MCP_PROTOCOL_VERSIONS = Object.freeze([
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
export const DEFAULT_MCP_PROTOCOL_VERSION = SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
export const MAX_MCP_TOOL_IMAGES = 16;

export const MCP_THINKING_LEVEL_MAP = Object.freeze({
  off: 0,
  none: 0,
  minimal: 0,
  low: 1,
  medium: 2,
  high: 2,
  xhigh: 2,
});

export function buildMcpToolDefinitions({ allowLocalImagePaths = false, models = Object.keys(MODEL_SPECS) } = {}) {
  const imageItemProperties = {
    url: {
      type: 'string',
      description: 'Inline data:image/(png|jpeg|webp);base64,... URL.',
    },
    ...(allowLocalImagePaths
      ? {
          path: {
            type: 'string',
            description: 'Local file path to a static PNG, JPEG, or WebP image (up to 20 MiB).',
          },
        }
      : {}),
  };

  return Object.freeze([
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
            enum: [...models],
            description:
              'Model ID: gemini-neon (default, highest capability, 512k), gemini-hydrogen (fast, 512k), gemini-flash-lite (lightweight, 128k)' +
              (models.includes('gemini-auto') ? ', or gemini-auto (dynamic routing / Free tier).' : '.'),
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
            maxItems: MAX_MCP_TOOL_IMAGES,
            description: allowLocalImagePaths
              ? 'Optional images (up to 16 static PNG/JPEG/WebP files or data:image/... URLs).'
              : 'Optional inline images (up to 16 static PNG/JPEG/WebP data:image/... URLs).',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: imageItemProperties,
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
        'Check Google Gemini account/pool availability, subscription tier, and saved or live quota windows.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
  ]);
}

export function normalizeMcpThinkingLevel(raw) {
  if (raw === undefined || raw === null) return 2;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 2) return raw;
  if (typeof raw === 'string') {
    const key = raw.trim().toLowerCase();
    if (Object.hasOwn(MCP_THINKING_LEVEL_MAP, key)) return MCP_THINKING_LEVEL_MAP[key];
  }
  throw Object.assign(
    new Error('Invalid `thinking_level`: expected 0..2 or one of off, none, minimal, low, medium, high, xhigh'),
    { code: 'INVALID_THINKING_LEVEL' },
  );
}

export function formatMcpCitationsMarkdown(annotations) {
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

export function normalizeAskGeminiArgs(args, { allowedModels = Object.keys(MODEL_SPECS), loadImages } = {}) {
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
  if (!allowedModels.includes(model)) {
    throw Object.assign(new Error(`Unsupported model "${rawModel}". Supported: ${allowedModels.join(', ')}`), {
      code: 'UNSUPPORTED_MODEL',
    });
  }
  const thinkingLevel = normalizeMcpThinkingLevel(args.thinking_level);
  const imageParts = loadImages ? loadImages(args.images) : loadInlineOnlyImageParts(args.images);
  const messages = [];
  if (system.trim()) messages.push({ role: 'system', content: system });
  messages.push({
    role: 'user',
    content: imageParts.length ? [{ type: 'text', text: prompt }, ...imageParts] : prompt,
  });
  return {
    model,
    messages,
    ...(model === 'gemini-auto' ? {} : { thinking_level: thinkingLevel }),
  };
}

export function normalizeGeminiSearchArgs(args) {
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
  return {
    model: 'gemini-neon',
    thinking_level: 2,
    native_search: true,
    messages,
  };
}

export function loadInlineOnlyImageParts(images) {
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
      throw Object.assign(new Error('Each image entry must be an object with `url`'), { code: 'INVALID_ARGUMENTS' });
    }
    if (item.path !== undefined) {
      throw Object.assign(
        new Error('Local filesystem `images[].path` is disabled on HTTP /mcp; pass inline `data:image/...` in `url` instead.'),
        { code: 'LOCAL_IMAGE_PATH_DISABLED' },
      );
    }
    if (typeof item.url !== 'string' || !item.url.trim()) {
      throw Object.assign(new Error('Each image entry must specify an inline `data:image/...` `url`'), {
        code: 'INVALID_ARGUMENTS',
      });
    }
    const decoded = decodeImageDataUrl(item.url.trim());
    parts.push({ type: 'image_url', image_url: { url: decoded.url, detail: 'auto' } });
  }
  return parts;
}

export function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

export function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function createMcpDispatcher({ toolHandlers, name = 'gemini-app2api', version = '1.0.0' } = {}) {
  if (!toolHandlers || typeof toolHandlers.callTool !== 'function' || !Array.isArray(toolHandlers.tools)) {
    throw new TypeError('toolHandlers with tools[] and callTool() is required');
  }

  const inflight = new Map();

  async function handleMessage(message, { signal: outerSignal } = {}) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return jsonRpcError(null, -32600, 'Invalid Request');
    }
    const hasId = Object.hasOwn(message, 'id') && message.id !== undefined;
    const id = hasId ? message.id : null;
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || !message.method) {
      return hasId ? jsonRpcError(id, -32600, 'Invalid Request') : null;
    }

    const { method, params } = message;

    if (method === 'notifications/initialized') return null;
    if (method === 'notifications/cancelled') {
      const targetId = params?.requestId;
      if (targetId !== undefined && inflight.has(targetId)) {
        try {
          inflight.get(targetId).abort(new Error(params?.reason || 'Cancelled by client'));
        } catch {}
      }
      return null;
    }
    if (!hasId) return null;

    if (method === 'initialize') {
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion.trim() : '';
      const protocolVersion = SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : DEFAULT_MCP_PROTOCOL_VERSION;
      return jsonRpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name, version },
      });
    }

    if (method === 'ping') return jsonRpcResult(id, {});
    if (method === 'tools/list') return jsonRpcResult(id, { tools: toolHandlers.tools });

    if (method === 'tools/call') {
      const toolName = typeof params?.name === 'string' ? params.name : '';
      if (!toolName) return jsonRpcError(id, -32602, 'Invalid params: tool `name` is required');
      const toolArgs = params?.arguments === undefined ? {} : params.arguments;
      if (!toolArgs || typeof toolArgs !== 'object' || Array.isArray(toolArgs)) {
        return jsonRpcError(id, -32602, 'Invalid params: `arguments` must be an object');
      }
      const controller = new AbortController();
      const onOuterAbort = () => controller.abort(outerSignal.reason);
      if (outerSignal) {
        if (outerSignal.aborted) controller.abort(outerSignal.reason);
        else outerSignal.addEventListener('abort', onOuterAbort, { once: true });
      }
      inflight.set(id, controller);
      try {
        const result = await toolHandlers.callTool(toolName, toolArgs, { signal: controller.signal });
        if (controller.signal.aborted) return null;
        return jsonRpcResult(id, result);
      } catch (err) {
        if (controller.signal.aborted) return null;
        return jsonRpcResult(id, {
          isError: true,
          content: [{ type: 'text', text: err?.message || 'Tool execution failed' }],
        });
      } finally {
        if (outerSignal) outerSignal.removeEventListener('abort', onOuterAbort);
        inflight.delete(id);
      }
    }

    return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }

  function cancelAll() {
    for (const controller of inflight.values()) {
      try {
        controller.abort(new Error('Server shutting down'));
      } catch {}
    }
    inflight.clear();
  }

  return { name, version, handleMessage, cancelAll };
}

/** In-memory HTTP response sink so Gateway POST /mcp can invoke execute() directly with zero loopback hops. */
export function createCaptureResponse() {
  const res = new EventEmitter();
  const headers = new Map();
  const chunks = [];
  res.statusCode = 200;
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
  res.writableNeedDrain = false;
  res.setHeader = (k, v) => { headers.set(String(k).toLowerCase(), v); };
  res.getHeader = (k) => headers.get(String(k).toLowerCase());
  res.writeHead = (code, hdrs = {}) => {
    res.statusCode = code;
    res.headersSent = true;
    for (const [k, v] of Object.entries(hdrs)) headers.set(String(k).toLowerCase(), v);
    return res;
  };
  res.write = (chunk) => {
    if (res.destroyed || res.writableEnded) return false;
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
    return true;
  };
  res.end = (chunk) => {
    if (chunk !== undefined) res.write(chunk);
    res.headersSent = true;
    res.writableEnded = true;
    res.emit('finish');
    return res;
  };
  res.destroy = () => {
    res.destroyed = true;
    res.emit('close');
    return res;
  };
  res.bodyText = () => Buffer.concat(chunks).toString('utf8');
  return res;
}

/** Sanitized pool-level quota summary for Gateway POST /mcp (never exposes emails, labels, tokens, or account IDs). */
export function formatGatewayPoolQuotaSummary({ overviewData, accountsList = [] } = {}) {
  const avail = overviewData?.availability || {};
  const tierCounts = new Map();
  let remainingKnown = 0;
  let remainingSum = 0;
  for (const acc of accountsList) {
    const tier = acc?.subscription?.tier || 'unknown';
    tierCounts.set(tier, (tierCounts.get(tier) || 0) + 1);
    const pct = acc?.quota?.remainingPercent;
    if (typeof pct === 'number' && Number.isFinite(pct)) {
      remainingKnown++;
      remainingSum += pct;
    }
  }
  const lines = [
    `Gemini App2API Pool Status (v${overviewData?.version || 'unknown'})`,
    `- Ready: ${overviewData?.ready ? 'yes' : 'no'}`,
    `- Eligible accounts: ${avail.eligibleAccounts ?? 0} / ${accountsList.length} total (${avail.verifiedAccounts ?? 0} verified)`,
  ];
  if (tierCounts.size) {
    const tiers = [...tierCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, n]) => `${k}: ${n}`)
      .join(', ');
    lines.push(`- Subscription tiers: ${tiers}`);
  }
  if (remainingKnown > 0) {
    lines.push(`- Saved remaining quota (avg across ${remainingKnown} account(s)): ${Math.round(remainingSum / remainingKnown)}%`);
  } else {
    lines.push('- Saved quota snapshots: none recorded yet (refresh in /admin Accounts to fetch live Google usage)');
  }
  return lines.join('\n');
}
