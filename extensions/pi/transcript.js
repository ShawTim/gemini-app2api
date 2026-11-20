import crypto from 'node:crypto';
import {
  decodeImageDataUrl,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
  MAX_IMAGE_URL_BYTES,
} from '../../src/image-input.mjs';

const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function sanitizeText(value) {
  if (typeof value !== 'string') return '';
  return value.isWellFormed() ? value : value.toWellFormed();
}

function sanitizeJsonStrings(value) {
  if (typeof value === 'string') {
    return value.isWellFormed() ? value : value.toWellFormed();
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonStrings);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[sanitizeText(k)] = sanitizeJsonStrings(v);
    }
    return out;
  }
  return value;
}

export function createToolCodec() {
  const rawToEncodedName = new Map();
  const encodedToRawName = new Map();
  const rawToEncodedIdQueue = new Map();
  const encodedToRawId = new Map();
  const usedEncodedIds = new Set();
  let idSeq = 0;

  function encodeToolName(rawName) {
    const key = typeof rawName === 'string' && rawName.length > 0 ? rawName : 'tool';
    if (rawToEncodedName.has(key)) {
      return rawToEncodedName.get(key);
    }
    if (/^[A-Za-z0-9_-]{1,64}$/.test(key) && !encodedToRawName.has(key)) {
      rawToEncodedName.set(key, key);
      encodedToRawName.set(key, key);
      return key;
    }
    const base = key.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '') || 'tool';
    let attempt = 0;
    while (true) {
      const hashInput = attempt === 0 ? key : `${key}\0${attempt}`;
      const hash = crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 8);
      const prefix = base.slice(0, Math.max(1, 64 - 1 - hash.length));
      const candidate = `${prefix}_${hash}`;
      if (!encodedToRawName.has(candidate)) {
        rawToEncodedName.set(key, candidate);
        encodedToRawName.set(candidate, key);
        return candidate;
      }
      attempt++;
    }
  }

  function decodeToolName(encodedName) {
    return encodedToRawName.get(encodedName) ?? encodedName;
  }

  function allocateUniqueCallId(rawId) {
    const key = typeof rawId === 'string' && rawId.length > 0 ? rawId : `call_${++idSeq}`;
    let candidate;
    if (/^[A-Za-z0-9_-]{1,256}$/.test(key) && !usedEncodedIds.has(key)) {
      candidate = key;
    } else {
      const sanitized = key.replace(/[^A-Za-z0-9_-]/g, '_') || 'call';
      const suffix = `_${++idSeq}`;
      candidate = `${sanitized.slice(0, Math.max(1, 256 - suffix.length))}${suffix}`;
      while (usedEncodedIds.has(candidate)) {
        const extraSuffix = `_${++idSeq}`;
        candidate = `${sanitized.slice(0, Math.max(1, 256 - extraSuffix.length))}${extraSuffix}`;
      }
    }
    usedEncodedIds.add(candidate);
    encodedToRawId.set(candidate, key);
    return candidate;
  }

  function encodeAssistantToolCallId(rawId) {
    const key = typeof rawId === 'string' && rawId.length > 0 ? rawId : `call_${++idSeq}`;
    const candidate = allocateUniqueCallId(key);
    let queue = rawToEncodedIdQueue.get(key);
    if (!queue) {
      queue = [];
      rawToEncodedIdQueue.set(key, queue);
    }
    queue.push(candidate);
    return candidate;
  }

  function encodeToolResultCallId(rawId) {
    const key = typeof rawId === 'string' && rawId.length > 0 ? rawId : '';
    const queue = key ? rawToEncodedIdQueue.get(key) : undefined;
    if (queue && queue.length > 0) {
      return queue.shift();
    }
    return allocateUniqueCallId(key || `call_${++idSeq}`);
  }

  function releaseEncodedToolCallId(encodedId) {
    const rawId = encodedToRawId.get(encodedId);
    if (!rawId) return;
    const queue = rawToEncodedIdQueue.get(rawId);
    if (!queue) return;
    const idx = queue.indexOf(encodedId);
    if (idx >= 0) queue.splice(idx, 1);
  }

  function decodeToolCallId(encodedId) {
    return encodedToRawId.get(encodedId) ?? encodedId;
  }

  return {
    encodeToolName,
    decodeToolName,
    encodeAssistantToolCallId,
    encodeToolResultCallId,
    releaseEncodedToolCallId,
    decodeToolCallId,
  };
}

export function resolveThinkingLevel(options = {}, { simple = false } = {}) {
  if (!simple && options?.thinking_level !== undefined) {
    if (options.thinking_level === 0 || options.thinking_level === 1 || options.thinking_level === 2) {
      return options.thinking_level;
    }
  }
  const reasoning = options?.reasoning;
  if (reasoning === undefined) {
    return simple ? 0 : 2;
  }
  if (reasoning === 'off' || reasoning === 'minimal') return 0;
  if (reasoning === 'low') return 1;
  if (reasoning === 'medium' || reasoning === 'high' || reasoning === 'xhigh') return 2;
  return simple ? 0 : 2;
}

function planImageBudget(messages) {
  const accepted = new Map();
  const degraded = new Map();
  let count = 0;
  let totalBytes = 0;

  for (let msgIndex = messages.length - 1; msgIndex >= 0; msgIndex--) {
    const message = messages[msgIndex];
    if (!message || (message.role !== 'user' && message.role !== 'toolResult')) continue;
    if (!Array.isArray(message.content)) continue;

    for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
      const block = message.content[blockIndex];
      if (!block || block.type !== 'image') continue;
      const key = `${msgIndex}:${blockIndex}`;
      const rawMime = typeof block.mimeType === 'string' ? block.mimeType.trim().toLowerCase() : '';
      const mimeType = rawMime === 'image/jpg' ? 'image/jpeg' : rawMime;

      if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
        degraded.set(key, `[Image omitted: unsupported format ${rawMime || 'unknown'}]`);
        continue;
      }
      if (typeof block.data !== 'string' || !block.data.length) {
        degraded.set(key, `[Image omitted: empty ${mimeType} payload]`);
        continue;
      }
      const compactBase64 = block.data.replace(/\s+/g, '');
      const byteLength = Buffer.byteLength(compactBase64, 'base64');
      const dataUrl = `data:${mimeType};base64,${compactBase64}`;
      if (byteLength <= 0 || byteLength > MAX_IMAGE_BYTES || Buffer.byteLength(dataUrl) > MAX_IMAGE_URL_BYTES) {
        degraded.set(key, `[Image omitted: ${mimeType} exceeded ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))}MB limit]`);
        continue;
      }
      if (count >= MAX_IMAGES) {
        degraded.set(key, `[Image omitted: ${mimeType} exceeded ${MAX_IMAGES}-image limit]`);
        continue;
      }
      if (totalBytes + byteLength > MAX_TOTAL_IMAGE_BYTES) {
        degraded.set(key, `[Image omitted: ${mimeType} exceeded ${Math.round(MAX_TOTAL_IMAGE_BYTES / (1024 * 1024))}MB total image budget]`);
        continue;
      }
      try {
        decodeImageDataUrl(dataUrl);
      } catch (err) {
        degraded.set(key, `[Image omitted: invalid ${mimeType} (${err?.code || 'INVALID_IMAGE'})]`);
        continue;
      }
      count++;
      totalBytes += byteLength;
      accepted.set(key, dataUrl);
    }
  }

  return { accepted, degraded };
}

function serializeToolArguments(block) {
  if (block.argumentsError) return '{}';
  if (typeof block.arguments === 'string') {
    try {
      const parsed = JSON.parse(block.arguments);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return sanitizeText(JSON.stringify(sanitizeJsonStrings(parsed)));
      }
    } catch {
      return '{}';
    }
    return '{}';
  }
  if (!block.arguments || typeof block.arguments !== 'object' || Array.isArray(block.arguments)) {
    return '{}';
  }
  try {
    const serialized = JSON.stringify(sanitizeJsonStrings(block.arguments));
    return typeof serialized === 'string' && serialized.startsWith('{') ? sanitizeText(serialized) : '{}';
  } catch {
    return '{}';
  }
}

function defaultContentText(content, separator = '\n') {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join(separator);
}

export function defaultGetCurrentTools(messages) {
  const tools = new Map();
  if (!Array.isArray(messages)) return [];
  for (const message of messages) {
    if (!message || message.role !== 'system') continue;
    for (const removed of message.toolsRemoved ?? []) {
      if (removed && typeof removed.name === 'string') {
        tools.delete(removed.name);
      }
    }
    for (const added of message.toolsAdded ?? []) {
      if (added && typeof added.name === 'string') {
        tools.set(added.name, added);
      }
    }
  }
  return [...tools.values()];
}

export function defaultGetCurrentSystemPrompt(messages) {
  if (!Array.isArray(messages)) return '';
  const contentParts = [];
  const sections = new Map();
  let sawSystemMessage = false;
  for (const message of messages) {
    if (!message || message.role !== 'system') continue;
    sawSystemMessage = true;
    const text = defaultContentText(message.content);
    if (text.length > 0) contentParts.push(text);
    if (message.sections && typeof message.sections === 'object') {
      for (const [name, value] of Object.entries(message.sections)) {
        if (value === null) {
          sections.delete(name);
        } else if (typeof value === 'string') {
          sections.set(name, value);
        }
      }
    }
  }
  if (!sawSystemMessage) return '';
  const parts = [];
  const base = contentParts.join('\n\n');
  if (base.length > 0) parts.push(base);
  for (const sectionText of sections.values()) {
    if (sectionText.length > 0) parts.push(sectionText);
  }
  return parts.join('\n\n');
}

export function defaultToToolDeclaration(tool) {
  const parameters =
    tool?.parameters !== undefined
      ? JSON.parse(JSON.stringify(tool.parameters))
      : { type: 'object' };
  return {
    name: tool?.name,
    description: tool?.description,
    parameters,
    ...(tool?.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: tool.constrainedSampling }),
  };
}

function normalizeContextMessages(context) {
  const baseMessages = Array.isArray(context?.messages) ? context.messages : [];
  const hasSystemPrompt =
    typeof context?.systemPrompt === 'string' && context.systemPrompt.length > 0;
  const hasTools = Array.isArray(context?.tools) && context.tools.length > 0;
  if (!hasSystemPrompt && !hasTools) {
    return baseMessages;
  }
  return [
    {
      role: 'system',
      content: hasSystemPrompt ? context.systemPrompt : '',
      ...(hasTools ? { toolsAdded: context.tools } : {}),
      timestamp: 0,
    },
    ...baseMessages,
  ];
}

export async function buildChatPayload(
  model,
  context,
  options = {},
  {
    getCurrentSystemPrompt = defaultGetCurrentSystemPrompt,
    getCurrentTools = defaultGetCurrentTools,
    toToolDeclaration = defaultToToolDeclaration,
    simple = false,
  } = {},
) {
  if (typeof getCurrentSystemPrompt !== 'function' || typeof getCurrentTools !== 'function' || typeof toToolDeclaration !== 'function') {
    throw new TypeError('Transcript helpers getCurrentSystemPrompt, getCurrentTools, and toToolDeclaration are required');
  }

  const rawMessages = normalizeContextMessages(context);
  const codec = createToolCodec();

  const rawTools = getCurrentTools(rawMessages) ?? [];
  const tools = rawTools.map((tool) => {
    const decl = toToolDeclaration(tool);
    const encodedName = codec.encodeToolName(decl.name);
    const parameters = decl.parameters && typeof decl.parameters === 'object' && !Array.isArray(decl.parameters)
      ? sanitizeJsonStrings(decl.parameters)
      : { type: 'object' };
    return {
      type: 'function',
      function: {
        name: encodedName,
        ...(typeof decl.description === 'string' ? { description: sanitizeText(decl.description) } : {}),
        parameters,
      },
    };
  });

  const { accepted: acceptedImages, degraded: degradedImages } = planImageBudget(rawMessages);
  const messages = [];

  const systemPrompt = sanitizeText(getCurrentSystemPrompt(rawMessages));
  if (typeof systemPrompt === 'string' && systemPrompt.length > 0) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  const pendingToolCallIds = [];
  const pendingToolCallSet = new Set();
  const pendingTurnImages = [];

  const flushPendingToolBatch = () => {
    if (pendingToolCallIds.length > 0) {
      for (const missingId of pendingToolCallIds) {
        codec.releaseEncodedToolCallId(missingId);
        messages.push({
          role: 'tool',
          tool_call_id: missingId,
          content: '[Tool execution aborted]',
        });
      }
      pendingToolCallIds.length = 0;
      pendingToolCallSet.clear();
    }
    if (pendingTurnImages.length > 0) {
      messages.push({
        role: 'user',
        content: pendingTurnImages.splice(0, pendingTurnImages.length),
      });
    }
  };

  for (let msgIndex = 0; msgIndex < rawMessages.length; msgIndex++) {
    const msg = rawMessages[msgIndex];
    if (!msg || typeof msg !== 'object') continue;
    if (msg.role === 'system') continue;

    if (msg.role === 'user') {
      flushPendingToolBatch();
      if (typeof msg.content === 'string') {
        messages.push({ role: 'user', content: sanitizeText(msg.content) });
        continue;
      }
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const parts = [];
      let hasImage = false;
      for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
        const block = blocks[blockIndex];
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: 'text', text: sanitizeText(block.text) });
        } else if (block.type === 'image') {
          const key = `${msgIndex}:${blockIndex}`;
          if (acceptedImages.has(key)) {
            hasImage = true;
            parts.push({ type: 'image_url', image_url: { url: acceptedImages.get(key) } });
          } else {
            parts.push({ type: 'text', text: degradedImages.get(key) ?? '[Image omitted]' });
          }
        }
      }
      if (!hasImage) {
        messages.push({ role: 'user', content: parts.map((part) => part.text).join('') });
      } else {
        messages.push({ role: 'user', content: parts });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      flushPendingToolBatch();
      const blocks =
        typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : Array.isArray(msg.content)
            ? msg.content
            : [];
      const textParts = [];
      const toolCalls = [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(sanitizeText(block.text));
        } else if (block.type === 'toolCall') {
          const encodedId = codec.encodeAssistantToolCallId(block.id);
          const encodedName = codec.encodeToolName(block.name);
          toolCalls.push({
            id: encodedId,
            type: 'function',
            function: {
              name: encodedName,
              arguments: serializeToolArguments(block),
            },
          });
        }
      }
      const joinedText = textParts.join('');
      if (toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: joinedText.length > 0 ? joinedText : null,
          tool_calls: toolCalls,
        });
        for (const call of toolCalls) {
          pendingToolCallIds.push(call.id);
          pendingToolCallSet.add(call.id);
        }
      } else {
        messages.push({
          role: 'assistant',
          content: joinedText,
        });
      }
      continue;
    }

    if (msg.role === 'toolResult') {
      const encodedId = codec.encodeToolResultCallId(msg.toolCallId);
      if (!pendingToolCallSet.has(encodedId)) {
        flushPendingToolBatch();
        const synthesizedName = codec.encodeToolName(msg.toolName || 'tool');
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: encodedId,
            type: 'function',
            function: { name: synthesizedName, arguments: '{}' },
          }],
        });
      } else {
        pendingToolCallSet.delete(encodedId);
        const idx = pendingToolCallIds.indexOf(encodedId);
        if (idx >= 0) pendingToolCallIds.splice(idx, 1);
      }

      const blocks =
        typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : Array.isArray(msg.content)
            ? msg.content
            : [];
      const textParts = [];
      for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
        const block = blocks[blockIndex];
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(sanitizeText(block.text));
        } else if (block.type === 'image') {
          const key = `${msgIndex}:${blockIndex}`;
          if (acceptedImages.has(key)) {
            pendingTurnImages.push({ type: 'image_url', image_url: { url: acceptedImages.get(key) } });
          } else {
            textParts.push(degradedImages.get(key) ?? '[Image omitted]');
          }
        }
      }

      let toolText = textParts.join('\n');
      if (msg.isError === true) {
        toolText = toolText.length > 0 ? `[Tool Error] ${toolText}` : '[Tool Error]';
      }

      messages.push({
        role: 'tool',
        tool_call_id: encodedId,
        content: toolText,
      });
    }
  }

  flushPendingToolBatch();

  let toolChoice;
  if (options?.toolChoice === 'none') {
    toolChoice = 'none';
  } else if (tools.length > 0 && (options?.toolChoice === 'auto' || options?.toolChoice === 'required')) {
    toolChoice = options.toolChoice;
  } else if (
    tools.length > 0 &&
    options?.toolChoice &&
    typeof options.toolChoice === 'object' &&
    options.toolChoice.type === 'function' &&
    typeof options.toolChoice.function?.name === 'string'
  ) {
    toolChoice = {
      type: 'function',
      function: { name: codec.encodeToolName(options.toolChoice.function.name) },
    };
  }

  let payload = {
    model: model.id,
    messages,
    stream: true,
    thinking_level: resolveThinkingLevel(options, { simple }),
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  };

  if (typeof options?.onPayload === 'function') {
    const replaced = await options.onPayload(payload, model);
    if (replaced !== undefined) {
      payload = replaced;
    }
  }

  return { payload, codec };
}
