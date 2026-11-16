import { ACCOUNT_MODELS, isProviderRejection } from "./provider-state.mjs";
import { METADATA_ERROR_CODES } from "./native-search-metadata.mjs";
import { isExplicitQuotaFailure } from "./quota-failover.mjs";

export const TELEMETRY_ERROR_CATEGORIES = Object.freeze([
  "quota",
  "auth",
  "precondition",
  "transient",
  "soft_error",
  "protocol",
  "other",
]);

const QUOTA_CODES = new Set([
  "NATIVE_QUOTA_EXHAUSTED",
  "NATIVE_QUOTA_INSUFFICIENT",
  "NATIVE_RATE_LIMITED",
  "RATE_LIMITED",
  "UPSTREAM_QUOTA",
  "QUOTA_EXHAUSTED",
]);

const AUTH_CODES = new Set([
  "NATIVE_PERMISSION_OR_AUTH",
  "NATIVE_AUTH_REJECTED",
  "NATIVE_PERMISSION_REJECTED",
  "NATIVE_CREDENTIAL_REQUIRED",
  "ACCOUNT_LOGIN_REQUIRED",
  "NATIVE_AUTH_FAILED",
  "AUTH_REQUIRED",
  "INVALID_API_KEY",
  "INVALID_OWNER",
]);

const TRANSIENT_CODES = new Set([
  "NATIVE_CONNECTION_FAILED",
  "NATIVE_STREAM_FAILED",
  "NATIVE_STREAM_RESET",
  "NATIVE_STREAM_CLOSED_EARLY",
  "NATIVE_HTTP_REJECTED",
  "NATIVE_TRANSPORT_TIMEOUT",
  "NATIVE_TURN_TIMEOUT",
  "OAUTH_REFRESH_FAILED",
  "UPSTREAM_UNAVAILABLE",
  "NATIVE_UPSTREAM_UNAVAILABLE",
  "NATIVE_TURN_FAILED",
  "NATIVE_TURN_ABORTED",
  "REQUEST_CANCELLED",
]);

const PROTOCOL_CODES = new Set([
  "MALFORMED_TOOL_CALL",
  "INVALID_TOOL_JSON",
  "TRUNCATED_TOOL_CALL",
  "INVALID_TOOL_CALL",
  "INVALID_TOOL_ARGUMENTS",
  "UNDECLARED_TOOL",
  "TOOL_ARGUMENT_SCHEMA_MISMATCH",
  "TOOL_CHOICE_NOT_SATISFIED",
  "TOOL_CHOICE_MISMATCH",
  "TOOL_CALL_NOT_ALLOWED",
  "PARALLEL_TOOL_CALLS_DISABLED",
  "TOOL_PROTOCOL_VIOLATION",
  "INVALID_STRUCTURED_OUTPUT",
  "INVALID_STRUCTURED_OUTPUT_JSON",
  "STRUCTURED_OUTPUT_INVALID",
  "STRUCTURED_OUTPUT_SCHEMA_MISMATCH",
  "STRUCTURED_OUTPUT_SCHEMA_VIOLATION",
  "STRUCTURED_OUTPUT_VALIDATION_FAILED",
  "INVALID_NATIVE_RESPONSE",
  "INVALID_NATIVE_EVENT",
  "NON_MONOTONIC_NATIVE_RESPONSE",
  "MISSING_NATIVE_MODE_EVIDENCE",
  "MODEL_DOWNGRADE_REJECTED",
  "NATIVE_SEARCH_NOT_OBSERVED",
  "UNSUPPORTED_NATIVE_TOOL_EVENT",
  "UNSUPPORTED_NATIVE_TOOL_REPORT",
  "INVALID_NATIVE_THINKING_LEVEL",
  "EMPTY_NATIVE_RESPONSE",
  "INCOMPLETE_NATIVE_RESPONSE",
  "NATIVE_OUTPUT_NOT_TEXT",
  "NATIVE_RESPONSE_REFUSED",
  "NATIVE_RESPONSE_LIMIT",
  "RESPONSE_TOO_LARGE",
  "NATIVE_METADATA_LIMIT",
  "NATIVE_TOOL_STATUS_LIMIT",
  "NATIVE_THINKING_MISMATCH",
  "NATIVE_ASYNC_RESPONSE_UNSUPPORTED",
  "NATIVE_FRAME_REJECTED",
  "NATIVE_INVALID_STATUS",
  "NATIVE_RECEIVE_LIMIT",
  "NATIVE_READER_BUSY",
  "NATIVE_TEXT_SNAPSHOT_TOOLS_FORBIDDEN",
  "INVALID_NATIVE_IMAGE_UPLOAD",
  "NATIVE_IMAGE_UPLOAD_INVALID_RESPONSE",
  ...Object.values(METADATA_ERROR_CODES),
]);

function createEmptyEntry() {
  return {
    requests: 0,
    successes: 0,
    failures: 0,
    inFlight: 0,
    outputBytes: 0,
    retries: 0,
    softErrors: 0,
    quotaErrors: 0,
    errorCounts: {
      quota: 0,
      auth: 0,
      precondition: 0,
      transient: 0,
      soft_error: 0,
      protocol: 0,
      other: 0,
    },
    lastUsedAt: null,
  };
}

function cloneEntry(entry) {
  return {
    ...entry,
    errorCounts: { ...entry.errorCounts },
  };
}

function createAccountMatrix() {
  return Object.fromEntries(ACCOUNT_MODELS.map((model) => [model, createEmptyEntry()]));
}

function cloneAccountMatrix(matrix) {
  return Object.fromEntries(
    ACCOUNT_MODELS.map((model) => [model, cloneEntry(matrix?.[model] ?? createEmptyEntry())]),
  );
}

/**
 * Measure byte size strictly from output content and serialized tool call metadata.
 * Never retains, logs, or inspects prompt or response text.
 */
export function measureOutputBytes(result) {
  if (!result || typeof result !== "object") return 0;
  const content = typeof result.content === "string" ? result.content : "";
  let bytes = Buffer.byteLength(content);
  if (Array.isArray(result.calls)) {
    for (const call of result.calls) {
      if (call !== undefined) {
        const serialized = JSON.stringify(call);
        if (serialized) bytes += Buffer.byteLength(serialized);
      }
    }
  }
  return bytes;
}

/**
 * Classify an error strictly by structured status/code fields for telemetry counters.
 */
export function classifyTelemetryError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "NATIVE_SOFT_ERROR_RESPONSE") return "soft_error";
  if (
    isExplicitQuotaFailure(error) ||
    error?.status === 429 ||
    error?.grpcStatus === 8 ||
    QUOTA_CODES.has(code)
  ) {
    return "quota";
  }
  if (error?.status === 401 || error?.status === 403 || AUTH_CODES.has(code)) {
    return "auth";
  }
  if (
    PROTOCOL_CODES.has(code) ||
    code.startsWith("STRUCTURED_OUTPUT_") ||
    code.endsWith("_STRUCTURED_OUTPUT") ||
    code.startsWith("METADATA_")
  ) {
    return "protocol";
  }
  if (code === "NATIVE_PRECONDITION_REQUIRED" || isProviderRejection(error)) {
    return "precondition";
  }
  if (TRANSIENT_CODES.has(code)) return "transient";
  return "other";
}

/**
 * Bounded in-memory telemetry tracking request, byte, retry, and failure counters
 * across (accountId, model) pairs and gateway-wide model totals without retaining
 * prompt text, response text, or credential data.
 */
export class ModelTelemetry {
  #now;
  #maxAccounts;
  #byAccount = new Map();
  #byModel = createAccountMatrix();
  #forgotten = new Set();

  constructor({ now = () => Date.now(), maxAccounts = 1024 } = {}) {
    this.#now = now;
    this.#maxAccounts = Number.isInteger(maxAccounts) && maxAccounts > 0 ? maxAccounts : 1024;
  }

  #accountTotalInFlight(matrix) {
    let total = 0;
    for (const model of ACCOUNT_MODELS) total += matrix[model].inFlight;
    return total;
  }

  #evictIdleIfFull() {
    if (this.#byAccount.size < this.#maxAccounts) return;
    for (const [id, matrix] of this.#byAccount) {
      if (this.#accountTotalInFlight(matrix) === 0) {
        this.#byAccount.delete(id);
        this.#forgotten.delete(id);
        if (this.#byAccount.size < this.#maxAccounts) return;
      }
    }
  }

  #touchAccount(accountId) {
    let matrix = this.#byAccount.get(accountId);
    if (!matrix) {
      this.#evictIdleIfFull();
      matrix = createAccountMatrix();
    } else {
      this.#byAccount.delete(accountId);
    }
    this.#byAccount.set(accountId, matrix);
    return matrix;
  }

  #cleanupIfForgotten(accountId) {
    if (!this.#forgotten.has(accountId)) return;
    const matrix = this.#byAccount.get(accountId);
    if (!matrix || this.#accountTotalInFlight(matrix) === 0) {
      this.#byAccount.delete(accountId);
      this.#forgotten.delete(accountId);
    }
  }

  #pairs(accountId, model) {
    if (!ACCOUNT_MODELS.includes(model) || typeof accountId !== "string" || !accountId) {
      return null;
    }
    const matrix = this.#touchAccount(accountId);
    return [matrix[model], this.#byModel[model]];
  }

  start(accountId, model, { isRetry = false } = {}) {
    const entries = this.#pairs(accountId, model);
    if (!entries) return;
    this.#forgotten.delete(accountId);
    const at = this.#now();
    for (const entry of entries) {
      entry.requests++;
      entry.inFlight++;
      if (isRetry) entry.retries++;
      entry.lastUsedAt = at;
    }
  }

  succeed(accountId, model, result) {
    const entries = this.#pairs(accountId, model);
    if (!entries) return;
    const bytes = measureOutputBytes(result);
    const at = this.#now();
    for (const entry of entries) {
      if (entry.inFlight > 0) entry.inFlight--;
      entry.successes++;
      entry.outputBytes += bytes;
      entry.lastUsedAt = at;
    }
    this.#cleanupIfForgotten(accountId);
  }

  fail(accountId, model, error) {
    const entries = this.#pairs(accountId, model);
    if (!entries) return;
    const category = classifyTelemetryError(error);
    const partialBytes = measureOutputBytes(error?.partialResult);
    const at = this.#now();
    for (const entry of entries) {
      if (entry.inFlight > 0) entry.inFlight--;
      entry.failures++;
      entry.outputBytes += partialBytes;
      entry.errorCounts[category]++;
      if (category === "soft_error") entry.softErrors++;
      if (category === "quota") entry.quotaErrors++;
      entry.lastUsedAt = at;
    }
    this.#cleanupIfForgotten(accountId);
  }

  /**
   * Drop per-account counters once all in-flight attempts finish while preserving
   * gateway-wide byModel totals.
   */
  forgetAccount(accountId) {
    const matrix = this.#byAccount.get(accountId);
    if (!matrix) {
      this.#forgotten.delete(accountId);
      return;
    }
    if (this.#accountTotalInFlight(matrix) === 0) {
      this.#byAccount.delete(accountId);
      this.#forgotten.delete(accountId);
    } else {
      this.#forgotten.add(accountId);
    }
  }

  hasAccount(accountId) {
    return this.#byAccount.has(accountId);
  }

  account(accountId) {
    return cloneAccountMatrix(this.#byAccount.get(accountId));
  }

  snapshot() {
    return {
      zeroPromptLogging: true,
      models: [...ACCOUNT_MODELS],
      byModel: cloneAccountMatrix(this.#byModel),
    };
  }
}
