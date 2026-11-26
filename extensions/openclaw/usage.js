import { fetchGoogleUsageInfo as defaultFetchGoogleUsageInfo } from '../../src/gateway/quota-transport.mjs';
import { fetchGoogleSubscription as defaultFetchGoogleSubscription } from '../../src/gateway/subscription-transport.mjs';
import { decodeUsageInfo as defaultDecodeUsageInfo } from '../../src/gateway/quota.mjs';
import { decodeSubscription as defaultDecodeSubscription } from '../../src/gateway/subscription.mjs';
import { SUBSCRIPTION_LABELS } from '../pi/provider.js';
import { PROVIDER_ID } from './models.js';

function parseResetMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

export function createOpenClawUsageFetcher({
  fetchGoogleUsageInfo,
  fetchGoogleSubscription,
  decodeUsageInfo = defaultDecodeUsageInfo,
  decodeSubscription = defaultDecodeSubscription,
} = {}) {
  const usageFetch = fetchGoogleUsageInfo || defaultFetchGoogleUsageInfo;
  const subFetch = fetchGoogleSubscription || (fetchGoogleUsageInfo ? null : defaultFetchGoogleSubscription);
  return async function fetchOpenClawUsageSnapshot(ctx) {
    const token = typeof ctx?.token === 'string' ? ctx.token.trim() : '';
    if (!token) {
      return {
        provider: PROVIDER_ID,
        displayName: 'Gemini App',
        windows: [],
        error: 'No OAuth token available for gemini-app.',
      };
    }
    const timeoutMs = Number.isFinite(ctx?.timeoutMs)
      ? Math.min(15_000, Math.max(1_000, Math.floor(ctx.timeoutMs)))
      : 10_000;
    try {
      const [usageRes, subRes] = await Promise.all([
        usageFetch(token, { signal: ctx?.signal, timeoutMs }),
        subFetch ? subFetch(token, { signal: ctx?.signal, timeoutMs }).catch(() => null) : Promise.resolve(null),
      ]);
      const usageInfo = decodeUsageInfo(usageRes.payload);
      let subscription = null;
      if (subFetch && subRes?.payload) {
        try {
          subscription = decodeSubscription(subRes.payload);
        } catch {}
      }
      const tier = subscription?.tier;
      const plan = tier && tier !== 'unknown' ? SUBSCRIPTION_LABELS[tier] || tier : undefined;
      const windows = (usageInfo?.usageRows || [])
        .filter((row) => row && typeof row.providerPercent === 'number' && Number.isFinite(row.providerPercent))
        .map((row) => {
          const resetAt = parseResetMs(row.providerTimestamp);
          return {
            label: row.label || 'Usage',
            usedPercent: Math.max(0, Math.min(100, Math.round(row.providerPercent))),
            ...(resetAt !== undefined ? { resetAt } : {}),
          };
        });
      return {
        provider: PROVIDER_ID,
        displayName: 'Gemini App',
        windows,
        ...(plan ? { plan } : {}),
        ...(!windows.length ? { summary: 'No active quota limits reported for this account.' } : {}),
      };
    } catch (err) {
      return {
        provider: PROVIDER_ID,
        displayName: 'Gemini App',
        windows: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };
}
