import http from "node:http";
import fs from "node:fs";
import crypto from "node:crypto";
import { TextDecoder } from "node:util";
import * as protocol from "../native-provider.mjs";
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
import { createResponseDelivery } from './response-delivery.mjs';
const uiRoot = new URL("../admin-v2/", import.meta.url);
const assets = new Map([
  ["/admin", "index.html"],
  ["/admin/", "index.html"],
  ["/admin/index.html", "index.html"],
  ["/admin/app.js", "app.js"],
  ["/admin/styles.css", "styles.css"],
]);
const sensitiveMethods = new Set(["POST", "PATCH", "DELETE", "PUT"]);
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
    ['opening_fence', 'closing_fence'].includes(toolReason) ? toolReason : null;
  const terminal = code === 'GENERATION_FAILED' && error?.terminalNoOutput === true;
  return {
    error: {
      message: terminal ? 'Generation ended without output. Gateway recovery is exhausted; this turn has failed.'
        : code === 'MALFORMED_TOOL_CALL' && toolProtocolReason ? `${code}: invalid ${toolProtocolReason} layout. No tool call was released.` : code,
      type:
        terminal ? "server_error" : error?.status === 401
          ? "authentication_error"
          : error?.status === 429 ? "rate_limit_error"
          : error?.status < 500
            ? "invalid_request_error"
            : "server_error",
      param: null,
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
async function readJson(req, limit) {
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
    chunks.push(chunk);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      ),
      value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error();
    // Two different measurements. The usage estimator works in characters; an
    // operator-facing byte limit must compare UTF-8 bytes, otherwise non-ASCII input
    // is undercounted by up to 3x. `length` is the raw received body byte count.
    Object.defineProperty(value, "__promptChars", { value: text.length, enumerable: false });
    Object.defineProperty(value, "__promptBytes", { value: length, enumerable: false });
    return value;
  } catch {
    throw fault("INVALID_JSON");
  }
}
function only(obj, keys) {
  if (Object.keys(obj).some((k) => !keys.includes(k)))
    throw fault("UNSUPPORTED_PARAMETER");
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
  secureCookies = false,
  publicOrigin = null,
  callbackPort = 18765,
  callbackHost = "127.0.0.1",
} = {}) {
  if (!store) throw new TypeError("store required");
  const startedAt = Date.now(),
    requests = [],
    audit = [];
  let active = 0,
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
    const eligible = pool.available("gemini-argon");
    const verified = eligible.filter(
      (a) => a.modelStates?.["gemini-argon"]?.state === "verified",
    ).length;
    return {
      defaultModel: "gemini-argon",
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
      version: "1.0.0",
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
      settings: effectiveSettings(),
      keyCount: store.listKeys().filter((k) => !k.revokedAt).length,
    };
  };
  async function execute(
    req,
    res,
    body,
    { owner, route, playground = false, accountTestId = null } = {},
  ) {
    if (req.aborted || res.destroyed) return;
    const canonical =
      route === "responses"
        ? protocol.normalizeResponsesRequest(body).body
        : protocol.normalizeChatRequest(body);
    const settings = store.settings();
    if (settings.allowRemoteImages !== true && canonical.messages.some(message =>
      Array.isArray(message.content) && message.content.some(part =>
        part.type === "image_url" && /^https?:/i.test(part.image_url.url))))
      throw fault("REMOTE_IMAGES_DISABLED", 403);
    // A conversation can grow past the point where the upstream finishes the turn at all.
    // Rejecting it up front turns a 70-200 s dead wait into an immediate, explicit answer.
    // Disabled by default (0).
    const promptLimit = settings.maxPromptBytes;
    if (Number.isSafeInteger(promptLimit) && promptLimit > 0 &&
      Number.isInteger(body.__promptBytes) && body.__promptBytes > promptLimit)
      throw fault("PROMPT_SIZE_LIMIT", 413);
    if (active >= settings.maxConcurrent) throw fault("GATEWAY_BUSY", 429);
    const outputStreaming = !playground && body.stream === true;
    const controller = new AbortController(),
      timer = setTimeout(() => {
        controller.abort(fault('REQUEST_DEADLINE', 504));
        if (res.headersSent && !res.destroyed && !res.writableEnded) res.destroy?.();
      }, settings.timeoutMs + 1000);
    timer.unref();
    controllers.add(controller);
    const delivery = createResponseDelivery(res, { route, stream: outputStreaming, model: canonical.model,
      thinkingLevel: canonical.thinking_level, reasoningEffort: canonical.reasoning_effort ?? canonical.reasoning?.effort,
      includeUsage: body.stream_options?.include_usage === true, parallelToolCalls: canonical.parallel_tool_calls ?? true,
      promptChars: body.__promptChars, deferEmptyStart: !playground && !accountTestId && !canonical.native_search,
      signal: controller.signal, writeTimeoutMs: Math.min(settings.timeoutMs, 30000) });
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
      identity = publicRequest ? resolveSessionIdentity(req.headers, canonical) : { sessionId: undefined, source: "admin" };
      const sid = identity.sessionId;
      description = describeRequest(canonical);
      if (publicRequest && canonical.model === 'gemini-argon' && !canonical.native_search)
        diagnostic = nativeDiagnostic.claim(id);
      const turn = async (acc, context) => {
        // A fresh attempt inherits nothing from a discarded short fragment.
        if (providerAttempts > 0) delivery.discard();
        accountId = acc;
        providerAttempts++;
        let attemptDiagnostic = null;
        try { attemptDiagnostic = diagnostic?.attempt(); } catch {}
        if (!res.headersSent) {
          res.setHeader("X-Gemini-Provider-Attempts", String(providerAttempts));
          res.setHeader("X-Gemini-Failover-Count", String(providerAttempts - 1));
          if (context.responseSessionId) res.setHeader('X-Session-ID', context.responseSessionId);
          if (context.failoverReason) res.setHeader("X-Gemini-Failover-Reason", context.failoverReason);
        }
        try { return await provider.runTurn(acc, canonical, event => delivery.accept(event), { ...context, timeoutMs: settings.timeoutMs,
          incrementalOutput: true, outputMode: outputStreaming ? 'stream' : 'buffered',
          getOutputCommitState: delivery.outputCommitState,
          ...(attemptDiagnostic ? { nativeDiagnostic: attemptDiagnostic } : {}) }); }
        catch (error) {
          // Only content the caller actually received commits this turn. A held
          // tiny prefix is still replaceable by one retry.
          error.responseStarted = delivery.publishedBytes > 0 || delivery.callCount > 0 || res.destroyed === true;
          if (!error.responseStarted && !error.unverifiedOutput && delivery.retryableShortfall) error.shortOutput = true;
          const evidence = safeNativeEvidence(error.nativeEvidence);
          const failure = { accountId: acc, status: Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 502,
            code: errorPayload(error).error.code, ...(evidence ? { nativeEvidence: evidence } : {}) };
          providerFailures.push(failure);
          if (!res.headersSent) res.setHeader('X-Gemini-Recovery-Errors', [...new Set(providerFailures.map(f => f.code))].join(','));
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
          !res.headersSent && !res.destroyed && !res.writableEnded &&
          controller.signal.reason?.code !== 'CLIENT_DISCONNECTED') {
        // Codex treats HTTP422 as a reconnectable Responses stream failure;
        // its terminal HTTP400 path is required. Keep server_error + upstream cause.
        const terminalStatus = route === 'responses' ? 400 : 422;
        const terminal = Object.assign(fault('GENERATION_FAILED', terminalStatus), {
          terminalNoOutput: true, upstreamCode: errorCode, upstreamStatus: status, nativeEvidence,
        });
        status = terminalStatus; errorCode = terminal.code; outputIncomplete = true; res.incomplete = true;
        res.setHeader('X-Should-Retry', 'false');
        throw terminal;
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
      req.off("aborted", disconnect);
      res.off("close", disconnect);
      requests.unshift({
        id,
        at,
        path: accountTestId ? "/admin/api/accounts/test" : playground
          ? "/admin/api/playground"
          : `/v1/${route === "responses" ? "responses" : "chat/completions"}`,
        model: canonical.model ?? "gemini-argon",
        accountId,
        status,
        durationMs: Date.now() - at,
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
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const host = req.headers.host;
      if (!origin) throw fault("STARTING", 503);
      const expected = new URL(origin);
      const address = server.address(),
        localPort =
          address && typeof address === "object"
            ? address.port
            : store.settings().port;
      const allowed = new Set([
        expected.host,
        `127.0.0.1:${localPort}`,
        `localhost:${localPort}`,
        `[::1]:${localPort}`,
      ]);
      if (!allowed.has(host)) throw fault("HOST_REJECTED", 403);
      const url = new URL(req.url, origin),
        p = url.pathname;
      if (req.method === "GET" && p === "/health")
        return json(res, {
          status: "ok",
          version: "1.0.0",
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
          security.checkOrigin(req, origin);
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
            if (!loopback || (req.headers.origin && req.headers.origin !== origin) || (site && site === "cross-site"))
              throw fault("ORIGIN_REJECTED", 403);
            if (site && !["same-origin", "none"].includes(site)) throw fault("ORIGIN_REJECTED", 403);
            if (host !== expected.host) throw fault("HOST_REJECTED", 403);
            const bootstrap = security.issueSession(remote);
            res.setHeader("Set-Cookie", security.cookie(bootstrap.token));
            session = { csrf: bootstrap.csrf };
          }
          if (!session) throw fault("ADMIN_LOGIN_REQUIRED", 401);
          return json(res, { authenticated: true, csrf: session.csrf, authRequired: security.adminAuthRequired });
        }
        const session = sensitiveMethods.has(req.method)
          ? security.requireMutation(req, origin)
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
          if (!protocol.NATIVE_MODELS.includes(input.model)) throw fault("UNSUPPORTED_MODEL");
          return await execute(req, res, { model: input.model, messages: [{ role: "user", content: "Reply with OK." }], thinking_level: 2 }, { owner: "admin-account-test", route: "chat", accountTestId: accountTest[1] });
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
          const b = await readJson(req, store.settings().maxBodyBytes);
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
        if (p === "/v1/models" && req.method === "GET")
          return json(res, {
            object: "list",
            data: protocol.NATIVE_MODELS.map((id) => ({
              id,
              object: "model",
              created: 0,
              owned_by: "google",
              // Advisory gateway budget, not a measured upstream token limit.
              ...(id === "gemini-argon" ? { context_window: 128000 } : {}),
            })),
          });
        if (
          req.method === "POST" &&
          ["/v1/chat/completions", "/v1/responses"].includes(p)
        ) {
          const body = await readJson(req, store.settings().maxBodyBytes);
          if (req.aborted || res.destroyed) return;
          const route = p.endsWith('responses') ? 'responses' : 'chat';
          if (allowAutomaticRecovery) {
            const canonical = route === 'responses' ? protocol.normalizeResponsesRequest(body).body : protocol.normalizeChatRequest(body);
            const { sessionId } = resolveSessionIdentity(req.headers, canonical);
            if (sessionId !== undefined) return await resumption.run({ req, res, owner, sessionId, route, body }, async (input, output) => {
              try { await execute(input, output, body, { owner, route }); }
              catch (error) { if (output.headersSent) { output.incomplete = true; output.end(); } else { output.discard(); json(output, errorPayload(error), Number.isInteger(error.status) ? error.status : 500); } }
            });
          }
          return await execute(req, res, body, { owner, route });
        }
        throw fault("UNSUPPORTED_ENDPOINT", 404);
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
      for (const c of controllers) c.abort(fault('SERVER_SHUTDOWN', 499));
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
