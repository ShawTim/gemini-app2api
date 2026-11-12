import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fixture } from "./gateway-fixture.mjs";
const body = {
  model: "gemini-argon",
  messages: [{ role: "user", content: "synthetic" }],
};
test("oversized fixed-length and chunked JSON return safe 413, not connection reset", async (t) => {
  const f = await fixture();
  t.after(f.close);
  f.store.data.settings.maxBodyBytes = 1024;
  const large = JSON.stringify({ ...body, padding: "x".repeat(8192) });
  const direct = await fetch(f.base + "/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + f.key.key,
      "Content-Type": "application/json",
    },
    body: large,
  });
  assert.equal(direct.status, 413);
  assert.equal((await direct.json()).error.code, "REQUEST_TOO_LARGE");
  const chunked = await new Promise((resolve, reject) => {
    const req = http.request(
      f.base + "/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + f.key.key,
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        },
      },
      (res) => {
        let value = "";
        res.setEncoding("utf8");
        res.on("data", (b) => (value += b));
        res.on("end", () => resolve({ status: res.statusCode, value }));
      },
    );
    req.on("error", reject);
    req.write(large.slice(0, 4000));
    const timer = setTimeout(() => {
      if (!req.destroyed) req.end(large.slice(4000));
    }, 100);
    timer.unref();
  });
  assert.equal(chunked.status, 413);
  assert.equal(JSON.parse(chunked.value).error.code, "REQUEST_TOO_LARGE");
  assert.equal(f.seen.length, 0);
  assert.equal((await f.request("/health")).status, 200);
});
test("unsupported continuation setting is rejected before any inference", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const r = await f.admin("settings", {
    method: "PATCH",
    body: { continuation: true },
  });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, "UNSUPPORTED_CONTINUATION");
  assert.equal(f.store.settings().continuation, false);
  assert.equal(f.seen.length, 0);
});
test("global generation capacity, same-session conflict and disconnect clean active resources", async (t) => {
  const f = await fixture({ delay: 180 });
  t.after(f.close);
  f.store.updateSettings({ maxConcurrent: 1 });
  const first = f.api("/v1/chat/completions", {
    method: "POST",
    body,
    headers: { "X-Session-ID": "bounded" },
  });
  while (!f.seen.length) await new Promise((r) => setTimeout(r, 5));
  assert.equal(
    (await f.api("/v1/chat/completions", { method: "POST", body })).status,
    429,
  );
  assert.equal((await first).status, 200);
  assert.equal(f.app.overview().metrics.active, 0);
  const controller = new AbortController();
  const pending = fetch(f.base + "/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + f.key.key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).catch((e) => e);
  while (f.seen.length < 2) await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await pending;
  await new Promise((r) => setTimeout(r, 240));
  assert.equal(f.app.overview().metrics.active, 0);
  assert.ok(f.cancelled > 0);
  assert.equal(
    f.app.pool.listSessions().some((s) => s.inFlight),
    false,
  );
});
