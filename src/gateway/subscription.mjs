// GetUsageInfo.user_tier=2 uses the native UserSubscriptionTier enum.
// Verified from SwiftProtobuf name-map/type metadata and an existing upstream payload.
import { parse } from '../../native-wire/protobuf.mjs';
import { fault } from './state.mjs';
export const SUBSCRIPTION_FIELDS = Object.freeze({ nativeTier: 2 });
const TIERS = Object.freeze({ 1: 'free', 2: 'pro', 3: 'ultra', 4: 'plus', 5: 'ultra_neon' });
const NAMES = Object.freeze({ 0: 'TIER_UNSPECIFIED', 1: 'BASIC_USER', 2: 'TIER1', 3: 'TIER2', 4: 'LITE_USER', 5: 'TIER_NEON' });
const CODES = new Set(['SUBSCRIPTION_CREDENTIAL_REQUIRED', 'INVALID_SUBSCRIPTION_TIMEOUT', 'INVALID_SUBSCRIPTION_METADATA',
  'SUBSCRIPTION_CANCELLED', 'SUBSCRIPTION_TIMEOUT', 'SUBSCRIPTION_STREAM_RESET', 'SUBSCRIPTION_RATE_LIMITED',
  'SUBSCRIPTION_AUTH_REJECTED', 'SUBSCRIPTION_HTTP_REJECTED', 'SUBSCRIPTION_INVALID_STATUS', 'SUBSCRIPTION_PRECONDITION_REQUIRED',
  'SUBSCRIPTION_UPSTREAM_REJECTED', 'SUBSCRIPTION_CONNECTION_FAILED', 'SUBSCRIPTION_RESPONSE_TOO_LARGE',
  'SUBSCRIPTION_INVALID_RESPONSE', 'SUBSCRIPTION_STREAM_FAILED', 'SUBSCRIPTION_STREAM_CLOSED_EARLY',
  'SUBSCRIPTION_INCOMPLETE_RESPONSE', 'SUBSCRIPTION_FETCH_FAILED', 'OAUTH_REFRESH_FAILED', 'NATIVE_PERMISSION_OR_AUTH',
  'ACCOUNT_LOGIN_REQUIRED']);
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 0x7fffffff ? value : null;
const timestamp = value => {
  if (typeof value !== 'string' || value.length > 40) return null;
  const ms = Date.parse(value); return Number.isFinite(ms) && ms >= 0 ? new Date(ms).toISOString() : null;
};
export const subscriptionFailureCode = error => CODES.has(error?.code) ? error.code : 'SUBSCRIPTION_FETCH_FAILED';
// Established read-only unary GetUsageInfo request is empty. No client-supplied tier.
export const buildSubscriptionRequest = () => Buffer.alloc(0);
export function safeSubscription(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const official = value.source === 'official' && value.provider === 'google-robin' && value.rpc === 'GetUsageInfo';
  const nativeTier = official ? integer(value.nativeTier) : null, tier = TIERS[nativeTier] ?? 'unknown';
  let status = ['unqueried', 'ok', 'missing', 'error'].includes(value.status) ? value.status : 'unqueried';
  if (status === 'ok' && (!official || tier === 'unknown')) status = 'missing';
  return { source: official ? 'official' : 'unknown', provider: official ? 'google-robin' : null, rpc: official ? 'GetUsageInfo' : null, status,
    tier, nativeTier, nativeTierName: nativeTier === null ? null : NAMES[nativeTier] ?? 'UNRECOGNIZED',
    // This RPC reports a tier, not billing/cancellation/forced-tier details.
    nativeState: null, membershipStatus: 'unknown', isForced: null,
    updatedAt: timestamp(value.updatedAt), lastAttemptAt: timestamp(value.lastAttemptAt),
    errorCode: status === 'error' ? subscriptionFailureCode({ code: value.errorCode }) : null };
}
export function decodeSubscription(payload) {
  try {
    if (!Buffer.isBuffer(payload) || payload.length > 512 * 1024) throw Error();
    const fields = parse(payload); if (fields.length > 10000) throw Error();
    const found = fields.filter(field => field.number === 2);
    if (found.length > 1 || (found.length && found[0].wire !== 0)) throw Error();
    let nativeTier = null;
    if (found.length) {
      let value = 0n, shift = 0n;
      for (const byte of found[0].payload) { value |= BigInt(byte & 127) << shift; shift += 7n; }
      if (value > 0x7fffffffn) throw Error();
      nativeTier = Number(value);
    }
    return safeSubscription({ source: 'official', provider: 'google-robin', rpc: 'GetUsageInfo', status: TIERS[nativeTier] ? 'ok' : 'missing', nativeTier });
  } catch { throw fault('INVALID_SUBSCRIPTION_METADATA', 502); }
}
