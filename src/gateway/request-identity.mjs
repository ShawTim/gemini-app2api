import crypto from 'node:crypto';
import { buildCanonicalPrompt } from '../openai-contract.mjs';
import { fault } from './state.mjs';

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const headerValue = (headers, name) => {
  if (!headers || typeof headers !== 'object') return undefined;
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
};

/** Resolve explicit session identity, with a narrowly-scoped PI cache-key fallback. */
export function resolveSessionIdentity(headers, canonical) {
  for (const name of ['x-session-id', 'x-session-affinity', 'session_id']) {
    const value = headerValue(headers, name);
    if (value !== undefined) {
      if (typeof value !== 'string' || !SESSION_ID.test(value)) throw fault('INVALID_SESSION_ID', 400);
      return { sessionId: value, source: name };
    }
  }
  const userAgent = headerValue(headers, 'user-agent');
  const isPi = typeof userAgent === 'string' && (/^pi \(/i.test(userAgent) || /^pi-desktop(?:\/|$)/i.test(userAgent));
  const cacheKey = canonical?.prompt_cache_key;
  if (isPi && typeof cacheKey === 'string' && cacheKey.length > 0 && Buffer.byteLength(cacheKey, 'utf8') <= 128) {
    // PI delegates inherit the parent's cache key. Their retained first user
    // message is the task brief, so include it to isolate logical branches.
    const anchor = canonical?.messages?.find(message => message.role === 'user')?.content ?? null;
    const digest = crypto.createHash('sha256').update(cacheKey, 'utf8').update('\0').update(JSON.stringify(anchor), 'utf8').digest('hex');
    return { sessionId: `pi_cache_${digest}`, source: 'pi_prompt_cache_key' };
  }
  return { sessionId: undefined, source: 'generated' };
}

/** Diagnostics only. Failed requests never create a future admission block. */
export function describeRequest(canonical) {
  const built = buildCanonicalPrompt(canonical);
  return {
    promptBytes: Buffer.byteLength(built.messages.map(message => message.content).join('\n'), 'utf8'),
    messageCount: Array.isArray(canonical.messages) ? canonical.messages.length : 0,
    toolCount: built.toolCount,
  };
}
