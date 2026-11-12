// Explicitly synthetic test fixture. Never reads user configuration or Google.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateStore } from "../src/gateway/state.mjs";
import { createGateway } from "../src/gateway/app.mjs";
import { Accounts } from "../src/gateway/accounts.mjs";
import {
  lengthDelimited as m,
  varintField as v,
} from "../native-wire/protobuf.mjs";
export const PASSWORD = "synthetic-admin-password-only";
export const tools = [
  {
    type: "function",
    function: {
      name: "fixture_lookup",
      description: "Synthetic lookup",
      parameters: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
    },
  },
];
export const responseTools = tools.map((t) => ({
  type: "function",
  ...t.function,
}));
export const toolBlock =
  '```tool_call\n{"name":"fixture_lookup","arguments":{"key":"sample"}}\n```';
export const textFrame = (text, mode = 8, thinking = 2) =>
  m(
    1003,
    m(
      1,
      Buffer.concat([
        m(1, m(2, m(1, Buffer.from(text)))),
        v(9, 1),
        v(11, 0),
        v(31, 0),
        v(41, mode),
        v(42, thinking),
      ]),
    ),
  );
export async function fixture({
  turns = [],
  accountCount = 2,
  allowFailover = true,
  allowQuotaFailover = false,
  allowEmptyResponseFailover = false,
  allowAutomaticRecovery = false,
  delay = 0,
  adminPassword = PASSWORD,
  quotaFetch,
  subscriptionFetch,
  downloadImages,
  termsAccept = async () => ({ status: "accepted", version: 1, legacyVersion: null, acceptedAt: new Date().toISOString() }),
  routingAccountIds = null,
} = {}) {
  const directory = fs.mkdtempSync(
    path.join(
      process.env.PI_SCRATCH_DIR || fs.realpathSync(os.tmpdir()),
      "gateway-http-fixture-",
    ),
  );
  const store = new StateStore({ directory, adminPassword });
  store.data.profile = {
    context: 2,
    enableFst: true,
    clientId: "123456789-fixture.apps.googleusercontent.com",
    clientSecret: "synthetic-only",
    scopes: ["https://www.googleapis.com/auth/assistant"],
  };
  for (let i = 0; i < accountCount; i++)
    store.data.accounts.push({
      id: `acc-${i}`,
      label: `Fixture ${i}`,
      enabled: true,
      status: "ready",
      refreshToken: `synthetic-refresh-${i}`,
      createdAt: Date.now(),
    });
  store.save();
  const accounts = new Accounts(store, {
    identify: async () => ({
      email: "synthetic@example.invalid",
      subject: "synthetic-subject",
    }),
    refresh: async () => ({
      accessToken: "synthetic-access",
      expiresInSeconds: 3600,
    }),
    // Automatic UI quota refresh must remain offline even when a test does not
    // explicitly supply a quota fixture. An empty snapshot means unknown, not0%.
    quotaFetch: quotaFetch ?? (async () => ({ payload: Buffer.alloc(0), observedAt: new Date().toISOString() })),
    ...(subscriptionFetch ? { subscriptionFetch } : {}),
    termsAccept,
  });
  const seen = [];
  let cancelled = 0;
  const app = createGateway({
    store,
    accounts,
    allowFailover,
    allowEmptyResponseFailover,
    allowAutomaticRecovery,
    allowQuotaFailover,
    routingAccountIds,
    downloadImages,
    // Explicitly synthetic uploads; fixture requests never contact Google.
    uploadImages: async (_token, images) => images.map((image, index) => ({ mimeType: image.mimeType, blobId: `synthetic_blob_${index}` })),
    openTurn: (token, options) => {
      seen.push(options);
      const candidate = turns.length ? turns.shift() : "Synthetic answer";
      const next =
        typeof candidate === "function" ? candidate(options) : candidate;
      return {
        events: {
          async *[Symbol.asyncIterator]() {
            if (delay) await new Promise((r) => setTimeout(r, delay));
            if (next instanceof Error) throw next;
            if (options.signal?.aborted)
              throw Object.assign(Error("fixture"), {
                code: "REQUEST_CANCELLED",
                status: 499,
              });
            yield {
              type: "frame",
              bytes: textFrame(
                typeof next === "string" ? next : next.text,
                next.mode ?? options.modeCategory,
                next.thinking ?? options.thinkingLevel,
              ),
            };
            yield {
              type: "frame",
              bytes: m(1014, m(1, m(1, Buffer.from("synthetic-conversation")))),
            };
            yield { type: "end", httpStatus: 200, grpcStatus: 0 };
          },
        },
        cancel() {
          cancelled++;
        },
      };
    },
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 }),
    key = store.createKey("Synthetic client");
  const request = async (p, { method = "GET", body, headers = {} } = {}) =>
    fetch(base + p, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const api = (p, options = {}) =>
    request(p, {
      ...options,
      headers: { Authorization: "Bearer " + key.key, ...options.headers },
    });
  const loginRes = await request("/admin/api/login", {
    method: "POST",
    body: { password: PASSWORD },
    headers: { Origin: base },
  });
  const cookie = loginRes.headers.get("set-cookie")?.split(";")[0],
    login = await loginRes.json();
  const admin = (p, options = {}) =>
    request("/admin/api/" + p, {
      ...options,
      headers: {
        Cookie: cookie,
        Origin: base,
        "X-CSRF-Token": login.csrf,
        ...options.headers,
      },
    });
  const close = async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  };
  return {
    app,
    store,
    base,
    key,
    api,
    admin,
    request,
    cookie,
    csrf: login.csrf,
    seen,
    get cancelled() {
      return cancelled;
    },
    close,
  };
}
