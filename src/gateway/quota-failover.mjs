// Verified native BardModeDowngradeReason values, not inferred from model identity.
export const QUOTA_DOWNGRADE_REASONS = Object.freeze({
  2: 'QUOTA_EXHAUSTED',
  3: 'FAST_FLASH_QUOTA_EXHAUSTED',
  6: 'GXU_QUOTA_EXHAUSTED',
  8: 'GXU_BUDGET_LOW',
});
export function quotaDowngradeCode(reason) {
  if (!Number.isSafeInteger(reason) || !Object.hasOwn(QUOTA_DOWNGRADE_REASONS, reason)) return null;
  return reason === 8 ? 'NATIVE_QUOTA_INSUFFICIENT' : 'NATIVE_QUOTA_EXHAUSTED';
}
export function isExplicitQuotaFailure(error) {
  return error?.status === 429 && ['NATIVE_QUOTA_EXHAUSTED', 'NATIVE_QUOTA_INSUFFICIENT'].includes(error.code);
}
