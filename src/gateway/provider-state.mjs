import { MODEL_MODES, NATIVE_MODELS } from "../openai-contract.mjs";
import { safeAccountError } from "./native-evidence.mjs";
export { NATIVE_MODELS as ACCOUNT_MODELS };
export const hasHydrogenAttribution = (value) =>
  typeof value === "string" && /\bhydrogen\b/i.test(value);
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
  if (value?.state === "unverified") return unchecked();
  if (
    value?.state === "verified" &&
    time(value.checkedAt) &&
    value.mode === MODEL_MODES[model] &&
    (model !== "gemini-hydrogen" || value.attributionVerified === true)
  )
    return {
      state: "verified",
      checkedAt: value.checkedAt,
      mode: value.mode,
      errorCode: null,
    };
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
  const prior = safeAccountError(account.lastError);
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
    (model === "gemini-hydrogen" && !hasHydrogenAttribution(result.attribution))
  )
    return null;
  return {
    state: "verified",
    checkedAt: now,
    mode: result.resolvedModeCategory,
    ...(model === "gemini-hydrogen" ? { attributionVerified: true } : {}),
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
