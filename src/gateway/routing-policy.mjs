import { fault } from './state.mjs';

// null = the ordinary product default; [] = explicitly deny all model routing.
// IDs remain private configuration, not a positional A/B label or model evidence.
export function normalizeRoutingAccountIds(value = null) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > 128 || [...value].some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) || new Set(value).size !== value.length)
    throw fault('INVALID_ROUTING_ACCOUNT_IDS', 400);
  return Object.freeze([...value]);
}

export function parseRoutingAccountIds(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 16 * 1024)
    throw fault('INVALID_ROUTING_ACCOUNT_IDS', 400);
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw fault('INVALID_ROUTING_ACCOUNT_IDS', 400); }
  // An explicitly supplied null/blank must not silently disable a restriction.
  if (!Array.isArray(parsed)) throw fault('INVALID_ROUTING_ACCOUNT_IDS', 400);
  return normalizeRoutingAccountIds(parsed);
}
