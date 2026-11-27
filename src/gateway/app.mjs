import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import { TextDecoder } from "node:util";
import * as protocol from "../native-provider.mjs";
import { CANONICAL_PROMPT_CHARS, CANONICAL_IMAGE_COUNT } from "../openai-contract.mjs";
import { RESPONSE_TOOL_IDENTITIES } from "../responses-tool-namespaces.mjs";
import { Security } from "./security.mjs";
import { openDirectTurn } from "./native-transport.mjs";
import { Accounts } from "./accounts.mjs";
import { AccountPool } from "./pool.mjs";
import { QUOTA_DOWNGRADE_REASONS, quotaDowngradeCode, isExplicitQuotaFailure } from "./quota-failover.mjs";
import { fault } from "./state.mjs";
import { resolveSessionIdentity, describeRequest } from "./request-identity.mjs";
import { safeNativeEvidence } from "./native-evidence.mjs";
import { RequestResumption } from './request-resumption.mjs';
import { QuotaRefreshJobs } from './quota-refresh-jobs.mjs';
import { NativeDiagnostic, observeNative } from './native-diagnostic.mjs';
import { createRequestTimings } from './request-timings.mjs';
import { createResponseDelivery } from './response-delivery.mjs';
import {
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  buildMcpToolDefinitions,
  createMcpDispatcher,
  createCaptureResponse,
  normalizeAskGeminiArgs,
  normalizeGeminiSearchArgs,
  formatMcpCitationsMarkdown,
  formatGatewayPoolQuotaSummary,
  jsonRpcError,
} from './mcp-core.mjs';
const uiRoot = new URL("../admin-v2/", import.meta.url);
function readPackageVersion() {
  try {
    const raw = JSON.parse(
      fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    const v = typeof raw?.version === "string" ? raw.version.trim() : "";
    return v || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
const PACKAGE_VERSION = readPackageVersion();
const assets = new Map([
  ["/admin", "index.html"],
  ["/admin/", "index.html"],
  ["/admin/index.html", "index.html"],
  ["/admin/app.js", "app.js"],
  ["/admin/styles.css", "styles.css"],
]);
const sensitiveMethods = new Set(["POST", "PATCH", "DELETE", "PUT"]);
function hasDuplicateHostHeader(rawHeaders) {
  if (!Array.isArray(rawHeaders)) return false;
  let count = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (typeof rawHeaders[i] === "string" && rawHeaders[i].toLowerCase() === "host") {
      count++;
      if (count > 1) return true;
    }
  }
  return false;
}
/** Parse and canonicalize an HTTP Host header while keeping explicit default ports intact. */
function parseHostHeader(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255)
    return null;
  if (raw.startsWith("[")) {
    const match = raw.match(/^\[([0-9a-fA-F:.]+)\](?::([1-9][0-9]{0,4}))?$/);
    if (!match || net.isIP(match[1]) !== 6) return null;
    const port = match[2] ?? "";
    if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
    let parsed;
    try {
      parsed = new URL(`http://[${match[1]}]`);
    } catch {
      return null;
    }
    const hostname = parsed.hostname.toLowerCase();
    return { hostname, bareHost: hostname.slice(1, -1), port, family: 6 };
  }
  const match = raw.match(/^([A-Za-z0-9._-]+)(?::([1-9][0-9]{0,4}))?$/);
  if (!match) return null;
  const hostPart = match[1];
  const port = match[2] ?? "";
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  let parsed;
  try {
    parsed = new URL(`http://${hostPart}`);
  } catch {
    return null;
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.port
  )
    return null;
  const hostname = parsed.hostname.toLowerCase();
  // Reject non-canonical IPv4 shorthand forms such as 127.1 or 2130706433.
  if (hostPart.toLowerCase() !== hostname) return null;
  return { hostname, bareHost: hostname, port, family: net.isIP(hostname) };
}
function isPrivateIPv4Bytes(a, b) {
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
function parseIPv6Words(bareHost) {
  const halves = bareHost.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  return groups.length === 8 ? groups.map((g) => parseInt(g, 16)) : null;
}
/** Parse optional GATEWAY_ALLOWED_PROBE_HOSTS (comma-separated string or array of host[:port]). */
export function parseProbeHosts(value) {
  if (value === undefined || value === null || value === "")
    return Object.freeze([]);
  let items;
  if (Array.isArray(value)) {
    if (value.length === 0) return Object.freeze([]);
    items = value;
  } else if (typeof value === "string") {
    if (Buffer.byteLength(value) > 8192) throw fault("INVALID_PROBE_HOSTS", 400);
    items = value.split(",").map((s) => s.trim());
  } else {
    throw fault("INVALID_PROBE_HOSTS", 400);
  }
  if (items.length > 64) throw fault("INVALID_PROBE_HOSTS", 400);
  const rules = [];
  for (const entry of items) {
    let raw;
    if (typeof entry === "string") {
      raw = entry.trim();
    } else if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      typeof entry.hostname === "string" &&
      typeof entry.port === "string"
    ) {
      raw = entry.port ? `${entry.hostname}:${entry.port}` : entry.hostname;
    } else {
      throw fault("INVALID_PROBE_HOSTS", 400);
    }
    const parsed = parseHostHeader(raw);
    if (!parsed) throw fault("INVALID_PROBE_HOSTS", 400);
    rules.push(Object.freeze({ hostname: parsed.hostname, port: parsed.port }));
  }
  return Object.freeze(rules);
}
/** Return true for built-in container/internal probe hosts or explicitly configured probe hosts. */
function isInternalProbeHost(parsedHost, customProbeHosts = []) {
  if (
    customProbeHosts.some(
      (rule) =>
        rule.hostname === parsedHost.hostname &&
        (rule.port === "" || (parsedHost.port || "80") === rule.port),
    )
  )
    return true;
  if (parsedHost.family === 4) {
    const [a, b] = parsedHost.bareHost.split(".").map(Number);
    return isPrivateIPv4Bytes(a, b);
  }
  if (parsedHost.family === 6) {
    const words = parseIPv6Words(parsedHost.bareHost);
    if (!words) return false;
    if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;
    if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff)
      return isPrivateIPv4Bytes(words[6] >> 8, words[6] & 0xff);
    return (words[0] & 0xfe00) === 0xfc00 || (words[0] & 0xffc0) === 0xfe80;
  }
  return (
    parsedHost.hostname === "localhost" ||
    /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/.test(parsedHost.hostname) ||
    /\.(?:internal|local|localhost|home\.arpa|svc|svc\.cluster\.local)$/.test(
      parsedHost.hostname,
    )
  );
}
// Terminal operation failure after bounded provider recovery, never an input limit.
const NO_OUTPUT_FAILURES = new Set(['NATIVE_STREAM_CLOSED_EARLY', 'NATIVE_TURN_TIMEOUT',
  'NATIVE_STREAM_RESET', 'NATIVE_CONNECTION_FAILED', 'NATIVE_STREAM_FAILED',
  'INCOMPLETE_NATIVE_RESPONSE', 'EMPTY_NATIVE_RESPONSE']);
export function errorPayload(error) {
  const code =
    typeof error?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(error.code)
      ? error.code
      : "INTERNAL_ERROR";
  const reason = error?.nativeEvidence?.downgradeReason;
  const quotaReason = isExplicitQuotaFailure(error) && quotaDowngradeCode(reason) === code
    ? QUOTA_DOWNGRADE_REASONS[reason] : null;
  const previousCode = typeof error?.previousErrorCode === "string" && /^[A-Z0-9_]{1,80}$/.test(error.previousErrorCode) ? error.previousErrorCode : null;
  const previousRequestId = typeof error?.previousRequestId === "string" && /^req_[A-Za-z0-9_-]{1,80}$/.test(error.previousRequestId) ? error.previousRequestId : null;
  const toolReason = error?.nativeEvidence?.toolProtocolReason ?? error?.toolProtocolReason;
  const toolProtocolReason = (code === 'MALFORMED_TOOL_CALL' || previousCode === 'MALFORMED_TOOL_CALL') &&
    ['opening_fence', 'closing_fence', 'hallucinated_caller_result'].includes(toolReason) ? toolReason : null;
  const terminal = code === 'GENERATION_FAILED' && error?.terminalNoOutput === true;
  const param =
    typeof error?.param === "string" &&
    /^[A-Za-z0-9_.\[\]-]{1,160}$/.test(error.param)
      ? error.param
      : null;
  return {
    error: {
      message: terminal ? 'Generation ended without output. Gateway recovery is exhausted; this turn has failed.'
        : code === 'MALFORMED_TOOL_CALL' && toolProtocolReason === 'hallucinated_caller_result' ? `${code}: upstream emitted a synthetic caller tool result marker. No tool call was released.`
        : code === 'MALFORMED_TOOL_CALL' && toolProtocolReason ? `${code}: invalid ${toolProtocolReason} layout. No tool call was released.`
        : code === 'UNSUPPORTED_PARAMETER' && param ? `UNSUPPORTED_PARAMETER: ${param}`
        : code === 'UNSUPPORTED_MODEL' ? 'UNSUPPORTED_MODEL: supported models are gemini-neon, gemini-hydrogen, gemini-flash-lite (alias: gemini-argon -> gemini-neon)'
        : code === 'NATIVE_UPSTREAM_UNAVAILABLE' ? 'NATIVE_UPSTREAM_UNAVAILABLE: upstream Google service temporarily unavailable (HTTP 503 / gRPC UNAVAILABLE)'
        : code === 'SERVER_SHUTDOWN' ? 'SERVER_SHUTDOWN: gateway is restarting; retry the request'
        : code,
      type:
        terminal ? "server_error" : error?.status === 401
          ? "authentication_error"
          : error?.status === 429 ? "rate_limit_error"
          : error?.status < 500
            ? "invalid_request_error"
            : "server_error",
      param,
      code,
      ...(terminal ? { terminal: true, retryable: false, client_action: 'stop_turn',
        upstream_code: error.upstreamCode, upstream_status: error.upstreamStatus } : {}),
      ...(previousCode ? { previous_code: previousCode } : {}),
      ...(previousRequestId ? { previous_request_id: previousRequestId } : {}),
      ...(quotaReason ? { quota_fallback: true, quota_reason: quotaReason } : {}),
      ...(toolProtocolReason ? { tool_protocol_reason: toolProtocolReason } : {}),
    },
  };
}
function json(res, value, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}
async function readJson(req, limit, { distinguishNonObject = false, budget = null } = {}) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] ?? ""))
    throw fault("JSON_CONTENT_TYPE_REQUIRED", 415);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) {
      req.resume();
      throw fault("REQUEST_TOO_LARGE", 413);
    }
    if (budget && !budget.reserve(chunk.length)) {
      req.resume();
      throw fault("GATEWAY_BUSY", 429);
    }
    chunks.push(chunk);
  }
  let text;
  let value;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    value = JSON.parse(text);
  } catch {
    throw fault("INVALID_JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw fault(distinguishNonObject ? "INVALID_REQUEST" : "INVALID_JSON");
  }
  // An operator-facing byte limit must compare UTF-8 bytes, otherwise non-ASCII input
  // is undercounted by up to 3x. `length` is the raw received body byte count.
  Object.defineProperty(value, "__promptBytes", { value: length, enumerable: false });
  return value;
}
function only(obj, keys) {
  const unexpected = Object.keys(obj).find((k) => !keys.includes(k));
  if (unexpected !== undefined) {
    const error = fault("UNSUPPORTED_PARAMETER");
    if (/^[A-Za-z0-9_.-]{1,64}$/.test(unexpected)) error.param = unexpected;
    throw error;
  }
}
export function createGateway({
  store,
  accounts,
  provider,
  openTurn = openDirectTurn,
  uploadImages,
  downloadImages,
  allowFailover = true,
  allowQuotaFailover = false,
  allowEmptyResponseFailover = false,
  allowAutomaticRecovery = false,
  routingAccountIds = null,
  probeHosts = null,
  secureCookies = false,
  publicOrigin = null,
  callbackPort = 18765,
  callbackHost = "127.0.0.1",
  keepaliveHeadersDelayMs = 45000,
  maxInFlightBodyBytes = null,
} = {}) {
  if (!store) throw new TypeError("store required");
  const normalizedProbeHosts = parseProbeHosts(probeHosts);
  const startedAt = Date.now(),
    requests = [],
    audit = [];
  let active = 0,
    inFlightBodyBytes = 0,
    totalRequests = 0,
    totalErrors = 0,
    closing = false,
    // A settings write during in-flight work defers cache invalidation to the
    // first idle moment instead of disturbing accepted requests.
    settingsInvalidationPending = false,
    origin = publicOrigin;
  const controllers = new Set(),
    inFlightTasks = new Set();
  const auditEvent = (action, target = null) => {
    audit.unshift({ id: crypto.randomUUID(), at: Date.now(), action, target });
    audit.length = Math.min(audit.length, 200);
  };
  accounts ??= new Accounts(store, {
    callbackPort,
    callbackHost,
    onChange: auditEvent,
  });
  provider ??= new protocol.NativeDirectProvider(accounts, {
    openTurn,
    uploadImages,
    downloadImages,
    timeoutMs: store.settings().timeoutMs,
    continuation: store.settings().continuation,
    maxSessions: store.settings().maxSessions,
    sessionTtlMs: store.settings().sessionTtlMs,
  });
  const pool = new AccountPool(accounts, {
    settings: () => store.settings(),
    allowFailover,
    allowQuotaFailover,
    allowEmptyResponseFailover,
    allowAutomaticRecovery,
    routingAccountIds,
    onFailover: () => auditEvent("request.failover"),
  });
  const quotaRefreshJobs = new QuotaRefreshJobs(accounts, {
    onComplete: job => auditEvent('quota.batch.' + job.status, job.id),
  });
  const security = new Security(store, { secureCookies });
  const resumption = new RequestResumption({ maxEntries: Math.min(64, store.settings().maxSessions) });
  const nativeDiagnostic = new NativeDiagnostic(store.directory);
  const effectiveSettings = () => ({
    ...store.settings(),
    ...(server.listening
      ? { port: server.address().port, host: server.address().address }
      : {}),
  });
  const ready = () =>
    !closing && !!store.data.profile && pool.available().length > 0;
  const availability = () => {
    const eligible = pool.available("gemini-neon");
    const verified = eligible.filter(
      (a) => a.modelStates?.["gemini-neon"]?.state === "verified",
    ).length;
    return {
      defaultModel: "gemini-neon",
      eligibleAccounts: eligible.length,
      verifiedAccounts: verified,
      upstreamVerified: verified > 0,
      automaticModelProbes: false,
      routingPolicy: pool.routingPolicy(),
    };
  };
  const overview = () => {
    const times = requests.map((r) => r.durationMs).sort((a, b) => a - b),
      quantile = (p) =>
        times.length
          ? times[Math.min(times.length - 1, Math.floor(times.length * p))]
          : 0;
    return {
      version: PACKAGE_VERSION,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      mode: "native-direct",
      toolProtocol: "prompt",
      generalFailoverDisabled: !allowFailover,
      quotaFailoverEnabled: pool.allowQuotaFailover,
      emptyResponseFailoverEnabled: pool.allowEmptyResponseFailover,
      automaticRecoveryEnabled: pool.allowAutomaticRecovery,
      requestResumption: { enabled: allowAutomaticRecovery, ...resumption.snapshot() },
      quotaRefresh: quotaRefreshJobs.summary(),
      ready: ready(),
      availability: availability(),
      metrics: {
        requests: totalRequests,
        errors: totalErrors,
        active,
        successRate: totalRequests
          ? Math.round((100 * (totalRequests - totalErrors)) / totalRequests)
          : 100,
        p50Ms: quantile(0.5),
        p95Ms: quantile(0.95),
      },
      accounts: pool.snapshotAccounts(),
      sessions: pool.listSessions(),
      failovers: [...pool.failovers],
      requests: [...requests],
      audit: [...audit],
      models: protocol.NATIVE_MODELS,
      modelTelemetry: pool.modelTelemetry(),
      settings: effectiveSettings(),
      keyCount: store.listKeys().filter((k) => !k.revokedAt).length,
    };
  };
  function assertPromptByteLimit(body) {
    const promptLimit = store.settings().maxPromptBytes;
    if (
      Number.isSafeInteger(promptLimit) &&
      promptLimit > 0 &&
      Number.isInteger(body?.__promptBytes) &&
      body.__promptBytes > promptLimit
    ) {
      throw fault("PROMPT_SIZE_LIMIT", 413);
    }
  }
  async function execute(
    req,
    res,
    body,
    { owner, route, playground = false, mcp = false, accountTestId = null, canonical: preNormalized = null, identity: preIdentity = null } = {},
  ) {
    if (req.aborted || res.destroyed) return;
    // A conversation can grow past the point where the upstream finishes the turn at all.
    // Rejecting it up front turns a 70-200 s dead wait into an immediate, explicit answer.
    // Disabled by default (0).
    assertPromptByteLimit(body);
    const settings = store.settings();
    if (active >= settings.maxConcurrent) throw fault("GATEWAY_BUSY", 429);
    const canonical =
      preNormalized ??
      (route === "responses"
        ? protocol.normalizeResponsesRequest(body).body
        : protocol.normalizeChatRequest(body));
    if (settings.allowRemoteImages !== true && canonical.messages.some(message =>
      Array.isArray(message.content) && message.content.some(part =>
        part.type === "image_url" && /^https?:/i.test(part.image_url.url))))
      throw fault("REMOTE_IMAGES_DISABLED", 403);
    const outputStreaming = !playground && body.stream === true;
    let hardDestroyTimer = null;
    const controller = new AbortController(),
      timer = setTimeout(() => {
        controller.abort(fault('REQUEST_DEADLINE', 504));
        if (res.headersSent && !res.destroyed && !res.writableEnded) {
          // Give delivery.interrupt() a short window to flush a clean SSE termination
          // frame (e.g. finish_reason: "tool_calls" + [DONE]); destroy immediately only
          // if the client socket is already backpressured, or after a 2s fallback.
          if (res.writableNeedDrain) {
            res.destroy?.();
          } else {
            hardDestroyTimer = setTimeout(() => {
              if (!res.destroyed && !res.writableEnded) res.destroy?.();
            }, 2000);
            hardDestroyTimer.unref?.();
          }
        }
      }, settings.timeoutMs + 1000);
    timer.unref();
    controllers.add(controller);
    const requestTimings = createRequestTimings();
    const delivery = createResponseDelivery(res, { route, stream: outputStreaming, model: canonical.model,
      thinkingLevel: canonical.thinking_level, reasoningEffort: canonical.reasoning_effort ?? canonical.reasoning?.effort,
      ignoredTokenParameters: ['max_tokens', 'max_completion_tokens'].filter(key => canonical[key] !== undefined),
      includeUsage: body.stream_options?.include_usage === true, parallelToolCalls: canonical.parallel_tool_calls ?? true,
      responseToolIdentities: canonical[RESPONSE_TOOL_IDENTITIES],
      promptChars: canonical[CANONICAL_PROMPT_CHARS] ?? 0, imageCount: canonical[CANONICAL_IMAGE_COUNT] ?? 0,
      deferEmptyStart: !playground && !accountTestId && !canonical.native_search,
      signal: controller.signal, writeTimeoutMs: Math.min(settings.timeoutMs, 30000),
      keepaliveHeadersDelayMs: route === 'chat' ? keepaliveHeadersDelayMs : 0,
      onFirstPublishedText: () => observeNative(requestTimings, 'markFirstPublishedText') });
    let resolveInFlight;
    const inFlightPromise = new Promise((r) => { resolveInFlight = r; });
    inFlightTasks.add(inFlightPromise);
    active++;
    totalRequests++;
    const id = "req_" + crypto.randomUUID(),
      at = Date.now();
    let accountId = null,
      status = 200,
      errorCode = null,
      toolCalls = 0,
      continued = false,
      nativeEvidence = null,
      nativeResponseRevisions = null,
      previousRequestId = null,
      identity = { sessionId: undefined, source: "generated" },
      description = null,
      providerAttempts = 0;
    let outputIncomplete = false;
    const providerFailures = [];
    let diagnostic = null;
    res.setHeader("X-Request-ID", id);
    res.setHeader("X-Gemini-Provider-Attempts", "0");
    res.setHeader("X-Gemini-Failover-Count", "0");
    const disconnect = () => {
      if (!res.writableEnded) controller.abort(fault('CLIENT_DISCONNECTED', 499));
    };
    req.once("aborted", disconnect);
    res.once("close", disconnect);
    if (req.aborted || res.destroyed) disconnect();
    try {
      const publicRequest = !accountTestId && !playground;
      identity = publicRequest ? (preIdentity ?? resolveSessionIdentity(req.headers, canonical)) : { sessionId: undefined, source: "admin" };
      const sid = identity.sessionId;
      description = describeRequest(canonical);
      if (publicRequest && canonical.model === 'gemini-neon' && !canonical.native_search)
        diagnostic = nativeDiagnostic.claim(id);
      const turn = async (acc, context) => {
        // A fresh attempt inherits nothing from a discarded short fragment.
        if (providerAttempts > 0) delivery.discard();
        accountId = acc;
        providerAttempts++;
        let attemptDiagnostic = null;
        try { attemptDiagnostic = diagnostic?.attempt(); } catch {}
        let attemptTiming = null;
        try { attemptTiming = requestTimings.startAttempt(); } catch {}
        if (!res.headersSent) {
          res.setHeader("X-Gemini-Provider-Attempts", String(providerAttempts));
          res.setHeader("X-Gemini-Failover-Count", String(providerAttempts - 1));
          if (context.responseSessionId) res.setHeader('X-Session-ID', context.responseSessionId);
          if (context.failoverReason) res.setHeader("X-Gemini-Failover-Reason", context.failoverReason);
          if (providerFailures.length) res.setHeader('X-Gemini-Recovery-Errors', [...new Set(providerFailures.map(f => f.code))].join(','));
        }
        try {
          const turnResult = await provider.runTurn(acc, canonical, event => delivery.accept(event), { ...context, timeoutMs: settings.timeoutMs,
            preNormalized: true, incrementalOutput: true, deferToolCalls: true, outputMode: outputStreaming ? 'stream' : 'buffered',
            getOutputCommitState: delivery.outputCommitState,
            ...(attemptTiming ? { timing: attemptTiming } : {}),
            ...(attemptDiagnostic ? { nativeDiagnostic: attemptDiagnostic } : {}) });
          observeNative(attemptTiming, 'finish', true);
          return turnResult;
        }
        catch (error) {
          observeNative(attemptTiming, 'finish', false);
          // Delivery owns the cross-attempt commit boundary: a held tiny prefix
          // or comment-only SSE keepalive header is still replaceable without splicing output.
          const disposition = delivery.attemptDisposition(error);
          error.responseStarted = disposition.replayBlocked;
          if (disposition.shortOutput) error.shortOutput = true;
          const evidence = safeNativeEvidence(error.nativeEvidence);
          const failure = { accountId: acc, status: Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502,
            code: errorPayload(error).error.code, ...(evidence ? { nativeEvidence: evidence } : {}) };
          providerFailures.push(failure);
          if (evidence) try {
            accounts.recordUpstreamError(acc, { at: Date.now(), status: failure.status, code: failure.code,
              model: canonical.model, nativeEvidence: evidence });
          } catch { /* Diagnostic persistence must not replace the provider error. */ }
          throw error;
        }
      };
      const output = accountTestId
        ? await pool.runTest(accountTestId, { model: canonical.model, signal: controller.signal }, turn)
        : await pool.run({ owner, sessionId: sid, signal: controller.signal, model: canonical.model }, turn);
      if (controller.signal.aborted) throw fault("REQUEST_CANCELLED", 499);
      const result = output.result;
      nativeEvidence = safeNativeEvidence(result.nativeEvidence);
      try {
        accounts.recordProviderSuccess(accountId, canonical.model, result);
      } catch {
        /* A diagnostic-state write must not fabricate an inference failure. */
      }
      toolCalls = result.calls?.length ?? 0;
      if (Number.isSafeInteger(result.revisionCount) && result.revisionCount >= 0 && result.revisionCount <= 4096) {
        nativeResponseRevisions = result.revisionCount;
        if (!res.headersSent) res.setHeader('X-Gemini-Response-Revisions', String(nativeResponseRevisions));
      }
      continued = !!result.continued;
      if (!res.headersSent) {
        res.setHeader("X-Request-ID", id);
        res.setHeader("X-Session-ID", output.sessionId);
        if (Number.isSafeInteger(result.resolvedModeCategory)) res.setHeader("X-Native-Mode", String(result.resolvedModeCategory));
        if (result.thinkingLevel !== null && result.thinkingLevel !== undefined) res.setHeader("X-Thinking-Level", String(result.thinkingLevel));
      }
      await delivery.complete(result);
    } catch (error) {
      if (controller.signal.reason?.code === 'REQUEST_DEADLINE') {
        error = Object.assign(fault('NATIVE_TURN_TIMEOUT', 504), { nativeEvidence: error.nativeEvidence });
      } else if (controller.signal.reason?.code === 'SERVER_SHUTDOWN') {
        error = Object.assign(fault('SERVER_SHUTDOWN', 503), { nativeEvidence: error.nativeEvidence });
        if (!res.headersSent) res.setHeader('Retry-After', '2');
      }
      status =
        Number.isInteger(error.status) &&
        error.status >= 400 &&
        error.status <= 599
          ? error.status
          : 502;
      errorCode = errorPayload(error).error.code;
      previousRequestId = errorPayload(error).error.previous_request_id ?? null;
      // Report the actual failure. Retrying never requires a local allowance.
      nativeEvidence = safeNativeEvidence(error.nativeEvidence);
      toolCalls = delivery.callCount;
      totalErrors++;
      // Internal attempts have finished. Do not turn an empty failed operation into
      // a retryable 5xx, empty success, fabricated token limit, or model-written reply.
      if (!playground && !accountTestId && !canonical.native_search && providerAttempts > 0 &&
          NO_OUTPUT_FAILURES.has(error.code) && !delivery.hasContent &&
          !error.partialResult?.content?.length && !error.partialResult?.calls?.length &&
          !res.destroyed && !res.writableEnded &&
          controller.signal.reason?.code !== 'CLIENT_DISCONNECTED') {
        // Codex treats HTTP422 as a reconnectable Responses stream failure;
        // its terminal HTTP400 path is required. Keep server_error + upstream cause.
        const terminalStatus = route === 'responses' ? 400 : 422;
        const terminal = Object.assign(fault('GENERATION_FAILED', terminalStatus), {
          terminalNoOutput: true, upstreamCode: errorCode, upstreamStatus: status, nativeEvidence,
        });
        if (!res.headersSent) {
          status = terminalStatus; errorCode = terminal.code; outputIncomplete = true; res.incomplete = true;
          res.setHeader('X-Should-Retry', 'false');
          throw terminal;
        }
        if (delivery.keepaliveOnlyHeaders) {
          error = terminal;
          errorCode = terminal.code;
        }
      }
      let interrupted = false;
      try {
        interrupted = await delivery.interrupt(error);
      } catch (interruptError) {
        error = interruptError;
        status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
        errorCode = errorPayload(error).error.code;
      }
      if (interrupted) { status = 200; outputIncomplete = true; return; }
      if (res.headersSent) status = res.statusCode;
      throw error;
    } finally {
      observeNative(diagnostic, 'finish', { status, errorCode, providerAttempts });
      active--;
      // Defer session-cache invalidation until all accepted work has finished.
      if (!active && settingsInvalidationPending) {
        settingsInvalidationPending = false;
        provider.sessions?.clear();
      }
      controllers.delete(controller);
      clearTimeout(timer);
      if (hardDestroyTimer !== null) clearTimeout(hardDestroyTimer);
      req.off("aborted", disconnect);
      res.off("close", disconnect);
      delivery.close();
      const timings = requestTimings.snapshot();
      requests.unshift({
        id,
        at,
        path: accountTestId ? "/admin/api/accounts/test" : playground
          ? "/admin/api/playground"
          : mcp ? "/mcp"
          : `/v1/${route === "responses" ? "responses" : "chat/completions"}`,
        model: canonical.model ?? "gemini-neon",
        accountId,
        status,
        durationMs: timings.totalMs,
        timings,
        errorCode,
        ...(controller.signal.aborted ? { cancellationSource: controller.signal.reason?.code === 'REQUEST_DEADLINE' ? 'request_deadline'
          : controller.signal.reason?.code === 'SERVER_SHUTDOWN' ? 'server_shutdown' : 'client_disconnect' } : {}),
        ...(previousRequestId ? { previousRequestId } : {}),
        toolCalls,
        continued,
        sessionSource: identity.source,
        providerAttempts,
        providerFailures,
        ...(outputIncomplete ? { outputIncomplete: true } : {}),
        ...(nativeResponseRevisions !== null ? { nativeResponseRevisions } : {}),
        ...(description ? { promptBytes: description.promptBytes, inputMessages: description.messageCount,
          declaredTools: description.toolCount } : {}),
        ...(nativeEvidence ? { nativeEvidence } : {}),
      });
      requests.length = Math.min(200, requests.length);
      inFlightTasks.delete(inFlightPromise);
      resolveInFlight();
    }
  }
  const server = http.createServer(async (req, res) => {
    let reservedBodyBytes = 0;
    let transferredBodyBudget = false;
    const bodyBudget = {
      reserve(n) {
        const limit = Number.isSafeInteger(maxInFlightBodyBytes) && maxInFlightBodyBytes > 0
          ? maxInFlightBodyBytes
          : Math.max(256 * 1024 * 1024, store.settings().maxBodyBytes * 2);
        if (inFlightBodyBytes + n > limit) return false;
        inFlightBodyBytes += n;
        reservedBodyBytes += n;
        return true;
      },
      release() {
        if (!transferredBodyBudget && reservedBodyBytes > 0) {
          inFlightBodyBytes = Math.max(0, inFlightBodyBytes - reservedBodyBytes);
          reservedBodyBytes = 0;
        }
      },
      transfer() {
        if (transferredBodyBudget) return () => {};
        transferredBodyBudget = true;
        let held = reservedBodyBytes;
        reservedBodyBytes = 0;
        return () => {
          if (held > 0) {
            inFlightBodyBytes = Math.max(0, inFlightBodyBytes - held);
            held = 0;
          }
        };
      },
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      if (!origin) throw fault("STARTING", 503);
      if (hasDuplicateHostHeader(req.rawHeaders))
        throw fault("HOST_REJECTED", 403);
      const parsedHost = parseHostHeader(req.headers.host);
      if (!parsedHost) throw fault("HOST_REJECTED", 403);
      if (
        typeof req.url !== "string" ||
        !req.url.startsWith("/") ||
        req.url.startsWith("//") ||
        req.url.includes("\\") ||
        req.url.includes("#") ||
        /%(?![0-9A-Fa-f]{2})|%00|[\u0000-\u001f\u007f]/.test(req.url)
      )
        throw fault("ENDPOINT_NOT_FOUND", 404);
      const expected = new URL(origin);
      let url;
      try {
        url = new URL(req.url, expected.origin);
      } catch {
        throw fault("ENDPOINT_NOT_FOUND", 404);
      }
      if (url.origin !== expected.origin)
        throw fault("ENDPOINT_NOT_FOUND", 404);
      const defaultPort = expected.protocol === "https:" ? "443" : "80";
      const expectedPort = expected.port || defaultPort;
      const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
      const expectedHostname = expected.hostname.toLowerCase();
      const expectedIsLoopbackHttp =
        expected.protocol === "http:" &&
        loopbackHosts.includes(expectedHostname);
      const adminAllowedHostnames = new Set(
        expectedIsLoopbackHttp ? loopbackHosts : [expectedHostname],
      );
      const isAdminHost =
        adminAllowedHostnames.has(parsedHost.hostname) &&
        (parsedHost.port || defaultPort) === expectedPort;
      const originPortSuffix =
        expectedPort === defaultPort ? "" : `:${expectedPort}`;
      const adminAllowedOrigins = new Set(
        expectedIsLoopbackHttp
          ? loopbackHosts.map((h) => `http://${h}${originPortSuffix}`)
          : [expected.origin],
      );
      const p = url.pathname;
      const isApiRoute = p.startsWith("/v1/") || p === "/mcp";
      const isProbeRoute =
        req.method === "GET" && (p === "/health" || p === "/ready");
      if (isProbeRoute) {
        if (
          !isAdminHost &&
          !isInternalProbeHost(parsedHost, normalizedProbeHosts)
        )
          throw fault("HOST_REJECTED", 403);
      } else if (!isApiRoute) {
        if (!isAdminHost) throw fault("HOST_REJECTED", 403);
      }
      if (req.method === "GET" && p === "/health")
        return json(res, {
          status: "ok",
          version: PACKAGE_VERSION,
          mode: "native-direct",
          toolProtocol: "prompt",
          liveValidation: !allowFailover && !pool.allowQuotaFailover && !pool.allowEmptyResponseFailover && !pool.allowAutomaticRecovery,
          generalFailoverDisabled: !allowFailover,
          quotaFailoverEnabled: pool.allowQuotaFailover,
          emptyResponseFailoverEnabled: pool.allowEmptyResponseFailover,
          automaticRecoveryEnabled: pool.allowAutomaticRecovery,
        });
      if (req.method === "GET" && p === "/ready")
        return json(
          res,
          {
            ready: ready(),
            ...availability(),
            reason: ready()
              ? null
              : closing
                ? "SHUTTING_DOWN"
                : !store.data.profile || accounts.list().length === 0
                  ? "ACCOUNT_OR_PROFILE_REQUIRED"
                  : "NO_ELIGIBLE_ACCOUNTS",
          },
          ready() ? 200 : 503,
        );
      if (req.method === "GET" && (p === "/" || p === "/admin")) {
        res.writeHead(302, { Location: "/admin/" + url.search });
        res.end();
        return;
      }
      if (req.method === "GET" && assets.has(p)) {
        const filename = assets.get(p);
        let bytes;
        try {
          bytes = fs.readFileSync(new URL(filename, uiRoot));
        } catch {
          throw fault("ADMIN_ASSET_UNAVAILABLE", 503);
        }
        res.writeHead(200, {
          "Content-Type": filename.endsWith(".html")
            ? "text/html; charset=utf-8"
            : filename.endsWith(".js")
              ? "text/javascript; charset=utf-8"
              : "text/css; charset=utf-8",
        });
        res.end(bytes);
        return;
      }
      if (p.startsWith("/admin/api/")) {
        if (req.method === "POST" && p === "/admin/api/login") {
          security.checkOrigin(req, adminAllowedOrigins);
          const body = await readJson(req, 4096);
          if (req.aborted || res.destroyed) return;
          only(body, ["password"]);
          const login = security.login(body.password, req.socket.remoteAddress);
          res.setHeader("Set-Cookie", security.cookie(login.token));
          auditEvent("admin.login");
          return json(res, { csrf: login.csrf, authRequired: security.adminAuthRequired });
        }
        if (p === "/admin/api/session" && req.method === "GET") {
          let session = security.session(req);
          if (!session && !security.adminAuthRequired) {
            const remote = req.socket.remoteAddress;
            const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
            const site = req.headers["sec-fetch-site"];
            if (
              !loopback ||
              (req.headers.origin &&
                !adminAllowedOrigins.has(req.headers.origin)) ||
              (site && site === "cross-site")
            )
              throw fault("ORIGIN_REJECTED", 403);
            if (site && !["same-origin", "none"].includes(site)) throw fault("ORIGIN_REJECTED", 403);
            if (!isAdminHost) throw fault("HOST_REJECTED", 403);
            const bootstrap = security.issueSession(remote);
            res.setHeader("Set-Cookie", security.cookie(bootstrap.token));
            session = { csrf: bootstrap.csrf };
          }
          if (!session) throw fault("ADMIN_LOGIN_REQUIRED", 401);
          return json(res, { authenticated: true, csrf: session.csrf, authRequired: security.adminAuthRequired });
        }
        const session = sensitiveMethods.has(req.method)
          ? security.requireMutation(req, adminAllowedOrigins)
          : security.requireAdmin(req);
        if (p === "/admin/api/logout" && req.method === "POST") {
          security.logout(session);
          res.setHeader("Set-Cookie", security.cookie("", { clear: true }));
          auditEvent("admin.logout");
          return json(res, { ok: true });
        }
        if (req.method === "GET" && p === "/admin/api/overview")
          return json(res, overview());
        if (req.method === "GET" && p === "/admin/api/accounts")
          return json(res, { accounts: pool.snapshotAccounts() });
        if (req.method === 'POST' && p === '/admin/api/accounts/quota-refresh') {
          const input = await readJson(req, 4096);
          if (req.aborted || res.destroyed) return;
          only(input, ['trigger']);
          const result = quotaRefreshJobs.start(input);
          if (!result.reused) auditEvent('quota.batch.started', result.job.id);
          return json(res, result, 202);
        }
        const quotaJob = p.match(/^\/admin\/api\/accounts\/quota-refresh\/(quota_refresh_[a-f0-9-]{36})$/);
        if (quotaJob && req.method === 'GET') return json(res, { job: quotaRefreshJobs.get(quotaJob[1]) });
        if (req.method === "POST" && p === "/admin/api/accounts/login") {
          const b = await readJson(req, 4096);
          if (req.aborted || res.destroyed) return;
          only(b, ["label", "acceptTerms"]);
          const result = await accounts.beginLogin(b.label, { acceptTerms: b.acceptTerms === undefined ? false : b.acceptTerms });
          auditEvent("account.login.started");
          return json(res, result, 201);
        }
        const flow = p.match(
          /^\/admin\/api\/accounts\/login\/([a-zA-Z0-9-]+)$/,
        );
        if (flow && req.method === "GET")
          return json(res, accounts.flow(flow[1]));
        if (flow && req.method === "DELETE") {
          accounts.cancelFlow(flow[1]);
          auditEvent("account.login.cancelled");
          return json(res, { ok: true });
        }
        const acceptTerms = p.match(/^\/admin\/api\/accounts\/([a-zA-Z0-9_-]+)\/terms\/accept$/);
        if (acceptTerms && req.method === 'POST') {
          const input = await readJson(req, 4096);
          if (req.aborted || res.destroyed) return;
          only(input, ['confirmed']);
          if (input.confirmed !== true) throw fault('CONFIRMATION_REQUIRED');
          const controller = new AbortController();
          const cancel = () => { if (!res.writableEnded) controller.abort(); };
          req.once('aborted', cancel); res.once('close', cancel); controllers.add(controller);
          if (req.aborted || res.destroyed) cancel();
          try {
            const terms = await accounts.acceptTerms(acceptTerms[1], { confirmed: true, signal: controller.signal });
            auditEvent('account.terms.accepted', acceptTerms[1]);
            return json(res, { terms, generationRequests: 0 });
          } finally {
            req.off('aborted', cancel); res.off('close', cancel); controllers.delete(controller);
          }
        }
        const identity = p.match(
          /^\/admin\/api\/accounts\/([a-zA-Z0-9_-]+)\/identity$/,
        );
        if (identity && req.method === "POST") {
          const body = await readJson(req, 4096);
          if (req.aborted || res.destroyed) return;
          only(body, []);
          const controller = new AbortController();
          const cancel = () => { if (!res.writableEnded) controller.abort(); };
          req.once("aborted", cancel); res.once("close", cancel); controllers.add(controller);
          if (req.aborted || res.destroyed) cancel();
          try {
            return json(res, await accounts.updateIdentity(identity[1], { signal: controller.signal }));
          } finally {
            req.off("aborted", cancel); res.off("close", cancel); controllers.delete(controller);
          }
        }
        const accountTest = p.match(/^\/admin\/api\/accounts\/([a-zA-Z0-9_-]+)\/test$/);
        if (accountTest && req.method === "POST") {
          const input = await readJson(req, 4096);
          if (req.aborted || res.destroyed) return;
          only(input, ["model"]);
          const model = protocol.canonicalModel(input.model);
          if (!protocol.NATIVE_MODELS.includes(model)) throw fault("UNSUPPORTED_MODEL");
          return await execute(req, res, { model, messages: [{ role: "user", content: "Reply with OK." }], thinking_level: 2 }, { owner: "admin-account-test", route: "chat", accountTestId: accountTest[1] });
        }
        const subscriptionRefresh = p.match(/^\/admin\/api\/accounts\/([a-zA-Z0-9_-]+)\/subscription$/);
        if (subscriptionRefresh && req.method === "POST") {
          const body = await readJson(req, 4096);
          if (req.aborted || res.destroyed) return;
          only(body, []);
          const controller = new AbortController();
          const cancel = () => { if (!res.writableEnded) controller.abort(); };
          req.once("aborted", cancel); res.once("close", cancel); controllers.add(controller);
          if (req.aborted || res.destroyed) cancel();
          try {
            const subscription = await accounts.refreshSubscription(subscriptionRefresh[1], { signal: controller.signal });
            auditEvent("subscription.refresh", subscriptionRefresh[1]);
            return json(res, { subscription });
          } finally {
            req.off("aborted", cancel); res.off("close", cancel); controllers.delete(controller);
          }
        }
        const quotaRefresh = p.match(new RegExp("^/admin/api/accounts/([a-zA-Z0-9_-]+)/quota$"));
        if (quotaRefresh && req.method === "POST") {
          const body = await readJson(req, 4096);
          if (req.aborted || res.destroyed) return;
          only(body, []);
          const controller = new AbortController();
          const cancel = () => { if (!res.writableEnded) controller.abort(); };
          req.once("aborted", cancel); res.once("close", cancel); controllers.add(controller);
          if (req.aborted || res.destroyed) cancel();
          try {
            const quota = await accounts.refreshQuota(quotaRefresh[1], { signal: controller.signal });
            auditEvent("quota.refresh", quotaRefresh[1]);
            return json(res, { quota });
          } finally {
            req.off("aborted", cancel); res.off("close", cancel); controllers.delete(controller);
          }
        }
        const acc = p.match(/^\/admin\/api\/accounts\/([a-zA-Z0-9_-]+)$/);
        if (acc && req.method === "PATCH") {
          const body = await readJson(req, 4096);
          if (req.aborted || res.destroyed) return;
          accounts.update(acc[1], body);
          if (active) settingsInvalidationPending = true;
          else provider.sessions?.clear();
          auditEvent("account.updated", acc[1]);
          return json(res, { ok: true });
        }
        if (acc && req.method === "DELETE") {
          accounts.remove(acc[1]);
          pool.forgetAccount(acc[1]);
          if (active) settingsInvalidationPending = true;
          else provider.sessions?.clear();
          auditEvent("account.removed", acc[1]);
          return json(res, { ok: true });
        }
        if (p === "/admin/api/keys" && req.method === "GET")
          return json(res, { keys: store.listKeys() });
        if (p === "/admin/api/keys" && req.method === "POST") {
          const b = await readJson(req, 4096);
          if (req.aborted || res.destroyed) return;
          only(b, ["label"]);
          const key = store.createKey(b.label);
          auditEvent("key.created", key.id);
          return json(res, key, 201);
        }
        const keyReveal = p.match(/^\/admin\/api\/keys\/([a-zA-Z0-9_-]+)\/reveal$/);
        if (keyReveal && req.method === "POST") {
          const b = await readJson(req, 4096);
          if (req.aborted || res.destroyed) return;
          only(b, []);
          const revealed = store.revealKey(keyReveal[1]);
          auditEvent("key.revealed", revealed.id);
          return json(res, revealed);
        }
        const key = p.match(/^\/admin\/api\/keys\/([a-zA-Z0-9_-]+)$/);
        if (key && req.method === "DELETE") {
          store.revokeKey(key[1]);
          provider.sessions?.clear();
          auditEvent("key.revoked", key[1]);
          return json(res, { ok: true });
        }
        if (p === "/admin/api/settings" && req.method === "GET")
          return json(res, effectiveSettings());
        if (p === "/admin/api/settings" && req.method === "PATCH") {
          const body = await readJson(req, 4096);
          if (req.aborted || res.destroyed) return;
          const value = store.updateSettings(body);
          // Accepted work keeps its settings snapshot; saving never aborts it.
          if (active) settingsInvalidationPending = true;
          else {
            provider.sessions?.clear();
          }
          auditEvent("settings.updated");
          return json(res, { ...value, port: effectiveSettings().port });
        }
        if (p === "/admin/api/diagnostics" && req.method === "GET") {
          const o = overview();
          return json(res, {
            version: o.version,
            mode: o.mode,
            toolProtocol: o.toolProtocol,
            ready: o.ready,
            uptimeSeconds: o.uptimeSeconds,
            metrics: o.metrics,
            modelTelemetry: o.modelTelemetry,
            counts: {
              accounts: o.accounts.length,
              sessions: o.sessions.length,
              keys: o.keyCount,
              failovers: o.failovers.length,
            },
            settings: o.settings,
            liveVerification: "not_implied_by_health",
          });
        }
        if (p === "/admin/api/playground" && req.method === "POST") {
          const b = await readJson(req, store.settings().maxBodyBytes, { budget: bodyBudget });
          if (req.aborted || res.destroyed) return;
          return await execute(req, res, b, {
            owner: "admin-playground",
            route: "chat",
            playground: true,
          });
        }
        throw fault("ENDPOINT_NOT_FOUND", 404);
      }
      if (p.startsWith("/v1/")) {
        const owner = security.apiOwner(req);
        if (url.search) throw fault("UNSUPPORTED_QUERY_PARAMETER");
        if (p === "/v1/models" && req.method === "GET") {
          return json(res, {
            object: "list",
            data: protocol.NATIVE_MODELS.map((id) => {
              const spec = protocol.MODEL_SPECS[id];
              return {
                id,
                object: "model",
                created: 0,
                owned_by: "google",
                // Advisory gateway budget, not a measured upstream token limit.
                ...(spec?.advertiseContextWindow
                  ? { context_window: spec.contextWindow }
                  : {}),
              };
            }),
          });
        }
        if (
          req.method === "POST" &&
          ["/v1/chat/completions", "/v1/responses"].includes(p)
        ) {
          const settings = store.settings();
          const body = await readJson(req, settings.maxBodyBytes, { budget: bodyBudget });
          if (req.aborted || res.destroyed) return;
          assertPromptByteLimit(body);
          const route = p.endsWith('responses') ? 'responses' : 'chat';
          // Check resumption followers before rejecting busy slots, and reject new
          // overloaded requests before expensive schema/image normalization.
          const explicitIdentity = resolveSessionIdentity(req.headers, null);
          const runResumableLeader = (input, output, opts) => {
            const releaseLeaderBody = bodyBudget.transfer();
            return (async () => {
              try { await execute(input, output, body, opts); }
              catch (error) { if (output.headersSent) { output.incomplete = true; output.end(); } else { output.discard(); json(output, errorPayload(error), Number.isInteger(error.status) ? error.status : 500); } }
              finally { releaseLeaderBody(); }
            })();
          };
          if (
            allowAutomaticRecovery &&
            resumption.size > 0 &&
            explicitIdentity.sessionId !== undefined &&
            resumption.has({ owner, sessionId: explicitIdentity.sessionId, route, body })
          ) {
            return await resumption.run({ req, res, owner, sessionId: explicitIdentity.sessionId, route, body }, (input, output) =>
              runResumableLeader(input, output, { owner, route }));
          }
          const maybePiResumptionFollower =
            allowAutomaticRecovery &&
            resumption.size > 0 &&
            explicitIdentity.sessionId === undefined &&
            typeof body.prompt_cache_key === 'string' &&
            body.prompt_cache_key.length > 0 &&
            resumption.hasBodyCandidate({ owner, route, body });
          if (active >= settings.maxConcurrent && !maybePiResumptionFollower) {
            throw fault("GATEWAY_BUSY", 429);
          }
          const canonical = route === 'responses'
            ? protocol.normalizeResponsesRequest(body).body
            : protocol.normalizeChatRequest(body);
          const identity = explicitIdentity.sessionId !== undefined
            ? explicitIdentity
            : resolveSessionIdentity(req.headers, canonical);
          if (allowAutomaticRecovery && identity.sessionId !== undefined) {
            if (active >= settings.maxConcurrent && !resumption.has({ owner, sessionId: identity.sessionId, route, body })) {
              throw fault("GATEWAY_BUSY", 429);
            }
            return await resumption.run({ req, res, owner, sessionId: identity.sessionId, route, body }, (input, output) =>
              runResumableLeader(input, output, { owner, route, canonical, identity }));
          }
          if (active >= settings.maxConcurrent) throw fault("GATEWAY_BUSY", 429);
          return await execute(req, res, body, { owner, route, canonical, identity });
        }
        throw fault("UNSUPPORTED_ENDPOINT", 404);
      }
      if (p === "/mcp") {
        // DNS-rebinding defense per MCP Streamable HTTP spec: allow absent Origin
        // (native CLI/HTTP clients), reject untrusted browser Origins.
        const originHeader = typeof req.headers.origin === "string" ? req.headers.origin.trim() : "";
        if (originHeader && !adminAllowedOrigins.has(originHeader)) {
          throw fault("ORIGIN_REJECTED", 403);
        }
        const owner = security.apiOwner(req);
        if (store.settings().mcpEnabled === false) {
          throw fault("MCP_DISABLED", 403);
        }
        if (url.search) throw fault("UNSUPPORTED_QUERY_PARAMETER");
        if (req.method !== "POST") {
          res.setHeader("Allow", "POST");
          return json(res, errorPayload(fault("METHOD_NOT_ALLOWED", 405)), 405);
        }
        const mcpProtoHeader = typeof req.headers["mcp-protocol-version"] === "string"
          ? req.headers["mcp-protocol-version"].trim()
          : "";
        if (mcpProtoHeader && !SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(mcpProtoHeader)) {
          return json(res, errorPayload(fault("UNSUPPORTED_MCP_PROTOCOL_VERSION", 400)), 400);
        }
        let rpcMessage;
        try {
          rpcMessage = await readJson(req, store.settings().maxBodyBytes, { distinguishNonObject: true, budget: bodyBudget });
        } catch (err) {
          if (err?.code === "INVALID_JSON") {
            return json(res, jsonRpcError(null, -32700, "Parse error"), 200);
          }
          if (err?.code === "INVALID_REQUEST") {
            return json(res, jsonRpcError(null, -32600, "Invalid Request"), 200);
          }
          throw err;
        }
        if (req.aborted || res.destroyed) return;
        const rawMcpBytes = typeof rpcMessage?.__promptBytes === "number" ? rpcMessage.__promptBytes : 0;
        const assertMcpPromptLimit = () => {
          const limit = store.settings().maxPromptBytes;
          if (limit > 0 && rawMcpBytes > limit) {
            throw Object.assign(
              new Error(`MCP request body (${rawMcpBytes} bytes) exceeds maxPromptBytes (${limit} bytes)`),
              { code: "PROMPT_SIZE_LIMIT", status: 413 },
            );
          }
        };
        const runGatewayChatTool = async (chatPayload, signal) => {
          const capture = createCaptureResponse();
          const onAbort = () => capture.destroy();
          signal?.addEventListener("abort", onAbort, { once: true });
          const serialized = JSON.stringify(chatPayload);
          const payloadWithBytes = { ...chatPayload, stream: false };
          Object.defineProperty(payloadWithBytes, "__promptBytes", {
            value: Math.max(rawMcpBytes, Buffer.byteLength(serialized, "utf8")),
            enumerable: false,
            configurable: true,
          });
          try {
            await execute(req, capture, payloadWithBytes, { owner, route: "chat", mcp: true });
          } finally {
            signal?.removeEventListener("abort", onAbort);
          }
          const rawText = capture.bodyText();
          const parsed = rawText ? JSON.parse(rawText) : null;
          if (capture.statusCode >= 400) {
            const code = parsed?.error?.code || `GATEWAY_HTTP_${capture.statusCode}`;
            const msg = parsed?.error?.message || `Gateway returned HTTP ${capture.statusCode}`;
            throw Object.assign(new Error(msg), { code, status: capture.statusCode });
          }
          const msg = parsed?.choices?.[0]?.message;
          const incomplete = parsed?.status === "incomplete" || Boolean(parsed?.error);
          return {
            content: typeof msg?.content === "string" ? msg.content : "",
            model: parsed?.model || chatPayload.model,
            annotations: Array.isArray(msg?.annotations) ? msg.annotations : [],
            usage: parsed?.usage ?? null,
            incomplete,
            incompleteReason: parsed?.error?.code || parsed?.incomplete_details?.reason || null,
          };
        };
        const gatewayMcpTools = {
          tools: buildMcpToolDefinitions({
            allowLocalImagePaths: false,
            models: protocol.NATIVE_MODELS,
          }),
          async callTool(name, args, { signal }) {
            try {
              if (name === "ask_gemini") {
                assertMcpPromptLimit();
                if (active >= store.settings().maxConcurrent) throw fault("GATEWAY_BUSY", 429);
                const chatPayload = normalizeAskGeminiArgs(args, {
                  allowedModels: protocol.NATIVE_MODELS,
                });
                const result = await runGatewayChatTool(chatPayload, signal);
                const text = result.content || "(empty response)";
                if (result.incomplete) {
                  return {
                    isError: true,
                    content: [{ type: "text", text: `[INCOMPLETE${result.incompleteReason ? `: ${result.incompleteReason}` : ""}] ${text}` }],
                    _meta: { model: result.model, incomplete: true, ...(result.usage ? { usage: result.usage } : {}) },
                  };
                }
                return {
                  content: [{ type: "text", text }],
                  _meta: {
                    model: result.model,
                    ...(result.usage ? { usage: result.usage } : {}),
                  },
                };
              }
              if (name === "gemini_search") {
                assertMcpPromptLimit();
                if (active >= store.settings().maxConcurrent) throw fault("GATEWAY_BUSY", 429);
                const chatPayload = normalizeGeminiSearchArgs(args);
                const result = await runGatewayChatTool(chatPayload, signal);
                const sourcesMd = formatMcpCitationsMarkdown(result.annotations);
                const text = (result.content || "(empty response)") + sourcesMd;
                if (result.incomplete) {
                  return {
                    isError: true,
                    content: [{ type: "text", text: `[INCOMPLETE${result.incompleteReason ? `: ${result.incompleteReason}` : ""}] ${text}` }],
                    _meta: { model: result.model, incomplete: true, citations: result.annotations.length },
                  };
                }
                return {
                  content: [{ type: "text", text }],
                  _meta: {
                    model: result.model,
                    citations: result.annotations.length,
                    ...(result.usage ? { usage: result.usage } : {}),
                  },
                };
              }
              if (name === "gemini_quota") {
                const text = formatGatewayPoolQuotaSummary({
                  overviewData: overview(),
                  accountsList: accounts.list(),
                });
                return { content: [{ type: "text", text }] };
              }
              return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
            } catch (err) {
              const code = err?.code ? `[${err.code}] ` : "";
              return {
                isError: true,
                content: [{ type: "text", text: `${code}${err?.message || "Tool execution failed"}` }],
              };
            }
          },
        };
        const mcpAbort = new AbortController();
        const onHttpClose = () => {
          if (!res.writableEnded) mcpAbort.abort(fault("CLIENT_DISCONNECTED", 499));
        };
        req.once("aborted", onHttpClose);
        res.once("close", onHttpClose);
        try {
          const dispatcher = createMcpDispatcher({
            toolHandlers: gatewayMcpTools,
            name: "gemini-app2api",
            version: PACKAGE_VERSION,
          });
          const rpcResponse = await dispatcher.handleMessage(rpcMessage, { signal: mcpAbort.signal });
          if (req.aborted || res.destroyed || res.writableEnded) return;
          if (rpcResponse === null) {
            res.writeHead(202);
            return res.end();
          }
          return json(res, rpcResponse, 200);
        } finally {
          req.off("aborted", onHttpClose);
          res.off("close", onHttpClose);
        }
      }
      throw fault("ENDPOINT_NOT_FOUND", 404);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const status =
        Number.isInteger(error.status) &&
        error.status >= 400 &&
        error.status <= 599
          ? error.status
          : 500;
      if (!res.headersSent) json(res, errorPayload(error), status);
      else res.end();
    } finally {
      bodyBudget.release();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  server.maxConnections = 128;
  return {
    server,
    store,
    accounts,
    quotaRefreshJobs,
    provider,
    pool,
    security,
    overview,
    async listen({
      host = store.settings().host,
      port = store.settings().port,
    } = {}) {
      if (!security.adminAuthRequired) {
        const loopbacks = ["127.0.0.1", "::1", "localhost"];
        let originUrl = null;
        try { originUrl = publicOrigin ? new URL(publicOrigin) : null; } catch { throw fault("ADMIN_PASSWORD_REQUIRED_FOR_REMOTE", 503); }
        if (!loopbacks.includes(host) || (originUrl && (!["http:", "https:"].includes(originUrl.protocol) || ![...loopbacks, "[::1]"].includes(originUrl.hostname))))
          throw fault("ADMIN_PASSWORD_REQUIRED_FOR_REMOTE", 503);
      }
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      if (!origin) {
        const addr = server.address();
        origin = `http://${host.includes(":") ? "[" + host + "]" : host === "0.0.0.0" ? "127.0.0.1" : host}:${addr.port}`;
      }
      return origin;
    },
    async close() {
      closing = true;
      for (const c of controllers) c.abort(fault('SERVER_SHUTDOWN', 503));
      resumption.close();
      await quotaRefreshJobs.close();
      const accountsDrain = Promise.resolve(accounts.close());
      server.closeIdleConnections();
      await new Promise((resolve) => {
        server.close(resolve);
        const timer = setTimeout(() => server.closeAllConnections(), 1500);
        timer.unref();
      });
      await Promise.allSettled([accountsDrain, ...inFlightTasks]);
    },
  };
}
