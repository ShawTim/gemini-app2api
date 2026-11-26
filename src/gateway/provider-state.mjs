import { MODEL_MODES, NATIVE_MODELS } from "../openai-contract.mjs";
import { safeAccountError } from "./native-evidence.mjs";
import { safeSubscription } from "./subscription.mjs";
export { NATIVE_MODELS as ACCOUNT_MODELS };
export const hasHydrogenAttribution = (value) =>
  typeof value === "string" && /\bhydrogen\b/i.test(value);
export const hasNeonAttribution = (value) =>
  typeof value === "string" && /\bneon\b/i.test(value);
export function isConfirmedFreeSubscription(account) {
  const sub = safeSubscription(account?.subscription);
  return (
    sub.source === "official" &&
    sub.rpc === "GetUserStatus" &&
    sub.status === "ok" &&
    sub.tier === "free"
  );
}
export function modelRoutingAllowed(account, model) {
  if (model === "gemini-neon" && isConfirmedFreeSubscription(account)) {
    const state = account?.modelStates?.[model] ?? modelState(account, model);
    return state?.state === "verified";
  }
  return true;
}
const requiresAttribution = (model) =>
  model === "gemini-hydrogen" || model === "gemini-neon";
const hasExpectedAttribution = (model, value) =>
  model === "gemini-hydrogen"
    ? hasHydrogenAttribution(value)
    : model === "gemini-neon"
      ? hasNeonAttribution(value)
      : true;
const time = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000;
const unchecked = () => ({
  state: "unverified",
  checkedAt: null,
  mode: null,
  errorCode: null,
});

// A server precondition rejection is not an OAuth login failure or a transient outage.
export function isProviderRejection(error) {
  const e = error?.nativeEvidence;
  return (
    e?.upstreamHttpStatus === 200 &&
    e?.grpcStatus === 9 &&
    e?.wireEnded === true
  );
}
export function modelState(account, model) {
  const value = account.providerStates?.[model];
  const prior = safeAccountError(account.lastError);
  if (value?.state === "unverified") return unchecked();
  if (
    value?.state === "verified" &&
    time(value.checkedAt) &&
    value.mode === MODEL_MODES[model] &&
    (!requiresAttribution(model) || value.attributionVerified === true)
  ) {
    if (
      prior?.code === "MODEL_DOWNGRADE_REJECTED" &&
      prior.model === model &&
      time(prior.at) &&
      prior.at >= value.checkedAt
    ) {
      return unchecked();
    }
    if (model === "gemini-neon" && isConfirmedFreeSubscription(account)) {
      const subAt = Date.parse(account.subscription?.updatedAt || "");
      if (!Number.isFinite(subAt) || subAt >= value.checkedAt) {
        return unchecked();
      }
    }
    return {
      state: "verified",
      checkedAt: value.checkedAt,
      mode: value.mode,
      errorCode: null,
    };
  }
  if (
    value?.state === "rejected" &&
    time(value.checkedAt) &&
    value.upstreamHttpStatus === 200 &&
    value.grpcStatus === 9
  )
    return {
      state: "rejected",
      checkedAt: value.checkedAt,
      mode: null,
      errorCode: "NATIVE_PRECONDITION_REQUIRED",
    };
  // Migrate prior observed failures without requesting Google or pretending they succeeded.
  if (
    prior &&
    (!prior.model || prior.model === model) &&
    isProviderRejection(prior)
  )
    return {
      state: prior.model ? "rejected" : "blocked",
      checkedAt: prior.at,
      mode: null,
      errorCode: "NATIVE_PRECONDITION_REQUIRED",
      scope: prior.model ? "model" : "account",
    };
  return unchecked();
}
export function modelStates(account) {
  return Object.fromEntries(
    NATIVE_MODELS.map((model) => [model, modelState(account, model)]),
  );
}
export function verifiedState(model, result, now = Date.now()) {
  if (
    !NATIVE_MODELS.includes(model) ||
    result?.model !== model ||
    result.resolvedModeCategory !== MODEL_MODES[model] ||
    (requiresAttribution(model) && !hasExpectedAttribution(model, result.attribution))
  )
    return null;
  return {
    state: "verified",
    checkedAt: now,
    mode: result.resolvedModeCategory,
    ...(requiresAttribution(model) ? { attributionVerified: true } : {}),
  };
}
export function rejectedState(error) {
  if (!isProviderRejection(error)) return null;
  return {
    state: "rejected",
    checkedAt: error.at,
    upstreamHttpStatus: 200,
    grpcStatus: 9,
  };
}
