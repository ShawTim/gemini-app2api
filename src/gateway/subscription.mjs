// GetUserStatusResponse.user_subscription_tier (wire field 21) uses the native UserSubscriptionTier enum.
// Requires RequestMetadata.clientCapabilities (field 6.2) with CapabilityType.ENABLE_USER_SUBSCRIPTION_TIER (529).
// GetUsageInfo.user_tier (field 2) is unreliable on upstream (reports TIER1 even for Free accounts).
import { parse, lengthDelimited } from '../../native-wire/protobuf.mjs';
import { buildRequestMetadata } from '../../native-wire/robin-current.mjs';
import { fault } from './oauth-client-defaults.mjs';
export const SUBSCRIPTION_FIELDS = Object.freeze({ nativeTier: 21, isForced: 29 });
export const SUBSCRIPTION_CAPABILITY_USER_TIER = 529;
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
// Read-only GetUserStatus request with RequestMetadata (field 1) advertising ENABLE_USER_SUBSCRIPTION_TIER (529).
export const buildSubscriptionRequest = () => lengthDelimited(
  1,
  buildRequestMetadata({
    clientType: 21,
    uiSource: 1,
    languageCode: 'en',
    interfaceLanguageCode: 'en',
    subscriptionTierCapability: true,
  }),
);
export function safeSubscription(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const official = value.source === 'official' && value.provider === 'google-robin' && value.rpc === 'GetUserStatus';
  const nativeTier = official ? integer(value.nativeTier) : null, tier = TIERS[nativeTier] ?? 'unknown';
  const isForced = official && typeof value.isForced === 'boolean' ? value.isForced : null;
  let status = ['unqueried', 'ok', 'missing', 'error'].includes(value.status) ? value.status : 'unqueried';
  if (status === 'ok' && (!official || tier === 'unknown')) status = 'missing';
  return { source: official ? 'official' : 'unknown', provider: official ? 'google-robin' : null, rpc: official ? 'GetUserStatus' : null, status,
    tier, nativeTier, nativeTierName: nativeTier === null ? null : NAMES[nativeTier] ?? 'UNRECOGNIZED',
    // GetUserStatus does not establish billing/cancellation ownership details.
    nativeState: null, membershipStatus: 'unknown', isForced,
    updatedAt: timestamp(value.updatedAt), lastAttemptAt: timestamp(value.lastAttemptAt),
    errorCode: status === 'error' ? subscriptionFailureCode({ code: value.errorCode }) : null };
}
function decodeBoundedVarint(payload, max = 0x7fffffffn) {
  if (!payload.length || payload.length > 10 || (payload.at(-1) & 128)) throw Error();
  let value = 0n, shift = 0n;
  for (const byte of payload) { value |= BigInt(byte & 127) << shift; shift += 7n; }
  if (value > max) throw Error();
  return Number(value);
}
export function decodeSubscription(payload) {
  try {
    if (!Buffer.isBuffer(payload) || payload.length > 512 * 1024) throw Error();
    const fields = parse(payload); if (fields.length > 10000) throw Error();
    const found = fields.filter(field => field.number === SUBSCRIPTION_FIELDS.nativeTier);
    if (found.length > 1 || (found.length && found[0].wire !== 0)) throw Error();
    const forced = fields.filter(field => field.number === SUBSCRIPTION_FIELDS.isForced);
    if (forced.length > 1 || (forced.length && forced[0].wire !== 0)) throw Error();
    const nativeTier = found.length ? decodeBoundedVarint(found[0].payload) : null;
    const isForced = forced.length ? decodeBoundedVarint(forced[0].payload, 1n) === 1 : null;
    return safeSubscription({ source: 'official', provider: 'google-robin', rpc: 'GetUserStatus', status: TIERS[nativeTier] ? 'ok' : 'missing', nativeTier, isForced });
  } catch { throw fault('INVALID_SUBSCRIPTION_METADATA', 502); }
}
