#!/usr/bin/env node
/** Product entry. Does not import the legacy server, IPC bridge or account store. */
import { StateStore, validateSettings, fault } from "./gateway/state.mjs";
import { createGateway } from "./gateway/app.mjs";
import { loadLocalEnvironment } from "./gateway/environment.mjs";
import { parseRoutingAccountIds } from './gateway/routing-policy.mjs';

let store, app;
try {
  loadLocalEnvironment();
  store = new StateStore();
  const settings = store.settings();
  if (process.env.GATEWAY_HOST !== undefined)
    settings.host = process.env.GATEWAY_HOST;
  if (process.env.PORT !== undefined) settings.port = Number(process.env.PORT);
  validateSettings(settings);
  const external = !["127.0.0.1", "::1"].includes(settings.host);
  let publicOrigin = process.env.GATEWAY_PUBLIC_ORIGIN ?? null;
  if (publicOrigin) {
    let u;
    try {
      u = new URL(publicOrigin);
    } catch {
      throw fault("INVALID_PUBLIC_ORIGIN");
    }
    if (
      !["http:", "https:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.pathname !== "/" ||
      u.search ||
      u.hash
    )
      throw fault("INVALID_PUBLIC_ORIGIN");
    if (
      u.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
    )
      throw fault("TLS_REQUIRED");
    publicOrigin = u.origin;
  }
  if (external && (process.env.GATEWAY_ALLOW_REMOTE !== "1" || !publicOrigin))
    throw fault("EXPLICIT_REMOTE_CONFIGURATION_REQUIRED");
  if (
    !process.env.GATEWAY_ADMIN_PASSWORD &&
    (external ||
      (publicOrigin &&
        !["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(publicOrigin).hostname,
        )))
  )
    throw fault("ADMIN_PASSWORD_REQUIRED_FOR_REMOTE", 503);
  const callbackPort = Number(process.env.GATEWAY_CALLBACK_PORT ?? 18765);
  if (
    !Number.isSafeInteger(callbackPort) ||
    callbackPort < 1 ||
    callbackPort > 65535
  )
    throw fault("INVALID_CALLBACK_PORT");
  const callbackHost = process.env.GATEWAY_CALLBACK_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "0.0.0.0"].includes(callbackHost))
    throw fault("INVALID_CALLBACK_HOST");
  if (callbackHost === "0.0.0.0" && process.env.GATEWAY_ALLOW_REMOTE !== "1")
    throw fault("EXPLICIT_REMOTE_CONFIGURATION_REQUIRED");
  const routingAccountIds = parseRoutingAccountIds(process.env.GATEWAY_ROUTING_ACCOUNT_IDS);
  const quotaFailover = process.env.GATEWAY_QUOTA_FAILOVER;
  if (quotaFailover !== undefined && !["0", "1"].includes(quotaFailover)) throw fault("INVALID_QUOTA_FAILOVER");
  const emptyFailover = process.env.GATEWAY_EMPTY_RESPONSE_FAILOVER;
  if (emptyFailover !== undefined && !["0", "1"].includes(emptyFailover)) throw fault("INVALID_EMPTY_RESPONSE_FAILOVER");
  const automaticRecovery = process.env.GATEWAY_AUTOMATIC_RECOVERY;
  if (automaticRecovery !== undefined && !['0', '1'].includes(automaticRecovery)) throw fault('INVALID_AUTOMATIC_RECOVERY');
  store.lock();
  app = createGateway({
    store,
    publicOrigin,
    secureCookies: publicOrigin?.startsWith("https:") ?? false,
    allowFailover: process.env.GATEWAY_LIVE_VALIDATION !== "1",
    allowQuotaFailover: quotaFailover === "1",
    allowEmptyResponseFailover: emptyFailover === "1",
    allowAutomaticRecovery: automaticRecovery === '1',
    routingAccountIds,
    callbackPort,
    callbackHost,
  });
  const origin = await app.listen(settings);
  console.log(
    JSON.stringify({
      event: "gateway.started",
      mode: "native-direct",
      origin,
      ready: app.overview().ready,
      toolProtocol: "prompt",
    }),
  );
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    store.unlock();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
} catch (error) {
  if (app) await app.close().catch(() => {});
  store?.unlock();
  const code = /^[A-Z0-9_]+$/.test(error.code ?? "")
    ? error.code
    : "STARTUP_FAILED";
  console.error(JSON.stringify({ event: "gateway.start_failed", code }));
  process.exitCode = 1;
}
