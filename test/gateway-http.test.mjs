import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  fixture,
  tools,
  responseTools,
  toolBlock,
} from "./gateway-fixture.mjs";
const chat = {
  model: "gemini-argon",
  messages: [{ role: "user", content: "Synthetic request" }],
};
async function setup(t, options) {
  const f = await fixture(options);
  t.after(f.close);
  return f;
}
async function until(check) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Synthetic request did not enter provider");
}
function holdTurns(f, t) {
  let release; const gate = new Promise(resolve => { release = resolve; });
  t.after(async () => { release(); await f.close(); });
  const open = f.app.provider.openTurn;
  f.app.provider.openTurn = (...args) => {
    const turn = open(...args), events = turn.events;
    return { ...turn, events: (async function* () { await gate; yield* events; })() };
  };
  return release;
}
test("HTTP health and readiness separate, models require API key and admin cookie cannot substitute", async (t) => {
  const f = await setup(t);
  assert.equal((await f.request("/health")).status, 200);
  assert.equal((await f.request("/ready")).status, 200);
  assert.equal((await f.request("/v1/models")).status, 401);
  assert.equal(
    (await f.request("/v1/models", { headers: { Cookie: f.cookie } })).status,
    401,
  );
  assert.equal(
    (
      await f.request("/admin/api/overview", {
        headers: { Authorization: "Bearer " + f.key.key },
      })
    ).status,
    401,
  );
  const models = await f.api("/v1/models").then((r) => r.json());
  assert.deepEqual(
    models.data.map((m) => m.id),
    ["gemini-argon", "gemini-hydrogen", "gemini-flash-lite"],
  );
  const hostStatus = await new Promise((resolve, reject) => {
    const request = http.get(
      f.base + "/health",
      { headers: { Host: "evil.invalid" } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.on("error", reject);
  });
  assert.equal(hostStatus, 403);
});
test("missing account readiness is 503; no virtual default inference", async (t) => {
  const f = await setup(t, { accountCount: 0 });
  assert.equal((await f.request("/ready")).status, 503);
  const r = await f.api("/v1/chat/completions", { method: "POST", body: chat });
  assert.equal(r.status, 503);
  assert.equal(f.seen.length, 0);
});
test("admin mutations require csrf and same origin, keys are one-time and revocation effective", async (t) => {
  const f = await setup(t);
  assert.equal(
    (
      await f.admin("keys", {
        method: "POST",
        body: { label: "one" },
        headers: { "X-CSRF-Token": "wrong" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.admin("keys", {
        method: "POST",
        body: { label: "one" },
        headers: { Origin: "https://evil.invalid" },
      })
    ).status,
    403,
  );
  const created = await f
    .admin("keys", { method: "POST", body: { label: "one" } })
    .then((r) => r.json());
  assert.ok(created.key);
  const keys = await f.admin("keys").then((r) => r.json());
  assert.equal(JSON.stringify(keys).includes(created.key), false);
  assert.equal(JSON.stringify(keys).includes("hash"), false);
  assert.equal(
    (
      await f.request("/v1/models", {
        headers: { Authorization: "Bearer " + created.key },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.admin("keys/" + created.id, { method: "DELETE" })).status,
    200,
  );
  assert.equal(
    (
      await f.request("/v1/models", {
        headers: { Authorization: "Bearer " + created.key },
      })
    ).status,
    401,
  );
  assert.equal((await f.admin("logout", { method: "POST" })).status, 200);
  assert.equal((await f.admin("overview")).status, 401);
});
test("accounts enabled/removed settings audit and diagnostic privacy", async (t) => {
  const f = await setup(t);
  assert.equal(
    (
      await f.admin("accounts/acc-0", {
        method: "PATCH",
        body: { enabled: false },
      })
    ).status,
    200,
  );
  const accounts = await f.admin("accounts").then((r) => r.json());
  assert.equal(accounts.accounts[0].enabled, false);
  assert.equal(
    (await f.admin("accounts/acc-0", { method: "DELETE" })).status,
    200,
  );
  assert.equal(
    (
      await f.admin("settings", {
        method: "PATCH",
        body: { maxConcurrent: 3, continuation: false },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.admin("settings", { method: "PATCH", body: { maxConcurrent: 0 } }))
      .status,
    400,
  );
  const d = await f.admin("diagnostics").then((r) => r.json());
  for (const value of [
    "synthetic-access",
    "synthetic-refresh",
    "synthetic-only",
    "fixture.apps",
    "Fixture 1",
  ])
    assert.equal(JSON.stringify(d).includes(value), false);
  const overview = await f.admin("overview").then((r) => r.json());
  assert.ok(overview.audit.some((a) => a.action === "account.removed"));
  assert.equal(overview.toolProtocol, "prompt");
});
test("chat tool first round and role tool result second round through actual HTTP", async (t) => {
  const f = await setup(t, { turns: [toolBlock, "SYNTHETIC_FINAL"] });
  const firstRes = await f.api("/v1/chat/completions", {
    method: "POST",
    body: { ...chat, tools },
    headers: { "X-Session-ID": "tool-chat" },
  });
  assert.equal(firstRes.status, 200);
  const first = (await firstRes.json()).choices[0];
  assert.equal(first.finish_reason, "tool_calls");
  assert.equal(first.message.tool_calls[0].function.name, "fixture_lookup");
  const second = await f.api("/v1/chat/completions", {
    method: "POST",
    headers: { "X-Session-ID": "tool-chat" },
    body: {
      ...chat,
      tools,
      messages: [
        ...chat.messages,
        first.message,
        {
          role: "tool",
          tool_call_id: first.message.tool_calls[0].id,
          content: "SYNTHETIC_RESULT",
        },
      ],
    },
  });
  assert.equal(second.status, 200);
  assert.equal(
    (await second.json()).choices[0].message.content,
    "SYNTHETIC_FINAL",
  );
  assert.ok(f.seen[1].messages[0].content.includes("SYNTHETIC_RESULT"));
  const logs = await f.admin("overview").then((r) => r.json());
  assert.equal(JSON.stringify(logs.requests).includes("SYNTHETIC"), false);
  assert.equal(logs.requests[1].toolCalls, 1);
});
test("Responses preserves model instructions thinking and function output", async (t) => {
  const f = await setup(t, { turns: [toolBlock, "SYNTHETIC_FINAL"] });
  const body = {
    model: "gemini-flash-lite",
    instructions: "SYNTHETIC_SYSTEM",
    thinking_level: 4, // Non-default synchronous level; 3 is async Deep Think.
    input: "Synthetic request",
    tools: responseTools,
  };
  const firstRes = await f.api("/v1/responses", { method: "POST", body });
  assert.equal(firstRes.status, 200);
  const first = await firstRes.json();
  assert.equal(first.model, "gemini-flash-lite");
  const call = first.output.find((i) => i.type === "function_call");
  assert.ok(call);
  assert.equal(f.seen[0].modeCategory, 6);
  assert.equal(f.seen[0].thinkingLevel, 4);
  assert.ok(f.seen[0].messages[0].content.includes("SYNTHETIC_SYSTEM"));
  const secondRes = await f.api("/v1/responses", {
    method: "POST",
    body: {
      ...body,
      input: [
        { role: "user", content: "Synthetic request" },
        call,
        {
          type: "function_call_output",
          call_id: call.call_id,
          output: "SYNTHETIC_RESULT",
        },
      ],
    },
  });
  assert.equal(secondRes.status, 200);
  const second = await secondRes.json();
  assert.equal(
    second.output.find((i) => i.type === "message").content[0].text,
    "SYNTHETIC_FINAL",
  );
  assert.ok(f.seen[1].messages[0].content.includes("SYNTHETIC_RESULT"));
});
for (const [name, body] of [
  ["unsupported model", { ...chat, model: "unsupported" }],
  ["unsupported option", { ...chat, unsupported_flag: true }],
  [
    "tool schema",
    {
      ...chat,
      tools: [
        {
          type: "function",
          function: {
            name: "fixture_lookup",
            parameters: { type: "object", oneOf: [] },
          },
        },
      ],
    },
  ],
])
  test("invalid input rejected before inference: " + name, async (t) => {
    const f = await setup(t);
    const r = await f.api("/v1/chat/completions", { method: "POST", body });
    assert.equal(r.status, 400);
    assert.equal(f.seen.length, 0);
    const e = await r.json();
    assert.ok(e.error.code);
  });
test("nonempty downgraded tool call never leaks SSE call or success", async (t) => {
  const f = await setup(t, { turns: [{ text: toolBlock, mode: 6 }] });
  const r = await f.api("/v1/chat/completions", {
    method: "POST",
    body: { ...chat, tools, stream: true },
  });
  assert.equal(r.status, 502);
  const text = await r.text();
  assert.equal(text.includes("fixture_lookup"), false);
  assert.equal(text.includes('"tool_calls"'), false);
  assert.equal(JSON.parse(text).error.code, "MODEL_DOWNGRADE_REJECTED");
});
test("bounded failover completes a single response, records a transition; auth rejection stops", async (t) => {
  const quota = Object.assign(Error("PRIVATE_ERROR_DETAIL"), {
    code: "NATIVE_QUOTA_EXHAUSTED",
    status: 429,
  });
  const f = await setup(t, { turns: [quota, "Recovered fixture"] });
  const r = await f.api("/v1/chat/completions", {
    method: "POST",
    body: chat,
    headers: { "X-Session-ID": "failover" },
  });
  assert.equal(r.status, 200);
  assert.equal(
    (await r.json()).choices[0].message.content,
    "Recovered fixture",
  );
  assert.equal(f.app.pool.failovers.length, 1);
  assert.equal(f.seen.length, 2);
  const d = await f.admin("diagnostics").then((r) => r.json());
  assert.equal(JSON.stringify(d).includes("PRIVATE"), false);
});
test("JSON body limit, invalid JSON and unsupported endpoint fail without inference", async (t) => {
  const f = await setup(t);
  const a = await fetch(f.base + "/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + f.key.key,
      "Content-Type": "application/json",
    },
    body: "{invalid",
  });
  assert.equal(a.status, 400);
  assert.equal(
    (await f.api("/v1/embeddings", { method: "POST", body: {} })).status,
    404,
  );
  const b = await fetch(f.base + "/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + f.key.key,
      "Content-Type": "text/plain",
    },
    body: "{}",
  });
  assert.equal(b.status, 415);
  assert.equal(f.seen.length, 0);
});
test("actual HTTP different same-session requests run concurrently without crossing caller ownership", async (t) => {
  const f = await fixture({ turns: ["First answer", "Second answer", "Other owner answer"] });
  const release = holdTurns(f, t);
  const body = {
      model: "gemini-argon",
      messages: [{ role: "user", content: "concurrent synthetic" }],
    },
    headers = { "X-Session-ID": "same-session" };
  const first = f.api("/v1/chat/completions", {
    method: "POST",
    body,
    headers,
  });
  await until(() => f.seen.length === 1);
  const second = f.api("/v1/chat/completions", {
    method: "POST", body: { ...body, messages: [{ role: "user", content: "Second input" }] }, headers,
  });
  await until(() => f.seen.length === 2);
  const otherKey = f.store.createKey("Other caller");
  const other = f.api("/v1/chat/completions", {
    method: "POST", body, headers: { ...headers, Authorization: "Bearer " + otherKey.key },
  });
  await until(() => f.seen.length === 3);
  assert.equal(f.app.overview().metrics.active, 3);
  assert.ok(f.app.pool.listSessions().some(s => s.inFlightCount === 2));
  release();
  for (const [pending, expected] of [[first, "First answer"], [second, "Second answer"], [other, "Other owner answer"]]) {
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, expected);
  }
  assert.equal(f.seen.length, 3);
  assert.equal(f.app.pool.listSessions().length, 2);
  assert.ok(f.app.pool.listSessions().every(s => s.inFlightCount === 0));
});
test("edited/rewound history and model/tool changes use fresh full replay without opaque handles", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const send = (body) =>
    f.api("/v1/chat/completions", {
      method: "POST",
      body,
      headers: { "X-Session-ID": "edits" },
    });
  assert.equal(
    (
      await send({
        model: "gemini-argon",
        messages: [{ role: "user", content: "original user" }],
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await send({
        model: "gemini-flash-lite",
        messages: [
          { role: "user", content: "original user" },
          { role: "assistant", content: "edited assistant" },
          { role: "user", content: "new followup" },
        ],
        tools,
        tool_choice: "none",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await send({
        model: "gemini-argon",
        messages: [{ role: "user", content: "rewound replacement" }],
      })
    ).status,
    200,
  );
  assert.match(f.seen[1].messages[0].content, /edited assistant/);
  assert.match(f.seen[1].messages[0].content, /new followup/);
  assert.equal(f.seen[1].modeCategory, 6);
  assert.match(f.seen[2].messages[0].content, /rewound replacement/);
  assert.doesNotMatch(
    f.seen[2].messages[0].content,
    /edited assistant|new followup|original user/,
  );
  for (const options of f.seen) assert.equal(options.continuation, undefined);
});
test("injected transient and auth HTTP failures preserve safe classification, full replay and no tool duplication", async (t) => {
  const transient = Object.assign(Error("private upstream details"), {
    code: "NATIVE_CONNECTION_FAILED",
    status: 502,
  });
  const f = await fixture({
    turns: [transient, toolBlock, "caller result accepted"],
  });
  t.after(f.close);
  const messages = [{ role: "user", content: "full context marker" }],
    headers = { "X-Session-ID": "failure-replay" };
  const first = await f.api("/v1/chat/completions", {
    method: "POST",
    headers,
    body: { model: "gemini-argon", messages, tools },
  });
  assert.equal(first.status, 200);
  const output = await first.json(),
    call = output.choices[0].message.tool_calls[0];
  assert.equal(output.choices[0].message.tool_calls.length, 1);
  assert.equal(f.seen.length, 2);
  assert.equal(f.seen[0].messages[0].content, f.seen[1].messages[0].content);
  assert.equal(f.app.pool.failovers[0].reason, "transient");
  messages.push(output.choices[0].message, {
    role: "tool",
    tool_call_id: call.id,
    content: "caller-only-result-marker",
  });
  const last = await f.api("/v1/chat/completions", {
    method: "POST",
    headers,
    body: { model: "gemini-argon", messages, tools, tool_choice: "none" },
  });
  assert.equal(last.status, 200);
  assert.equal(f.seen.length, 3);
  assert.match(f.seen[2].messages[0].content, /caller-only-result-marker/);
  const rejected = await fixture({
    turns: [
      Object.assign(Error("private auth rejection"), {
        code: "NATIVE_PERMISSION_OR_AUTH",
        status: 403,
      }),
    ],
  });
  t.after(rejected.close);
  const r = await rejected.api("/v1/chat/completions", {
    method: "POST",
    body: {
      model: "gemini-argon",
      messages: [{ role: "user", content: "test" }],
    },
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, "NATIVE_PERMISSION_OR_AUTH");
  assert.equal(rejected.seen.length, 1);
  assert.equal(rejected.app.pool.failovers.length, 0);
  assert.equal(rejected.store.data.accounts[0].status, "ready");
  assert.equal(rejected.store.data.accounts[0].refreshToken, "synthetic-refresh-0");
  assert.equal(rejected.app.accounts.access.has("acc-0"), false, "generation permission failure invalidates only cached access");
});

test("account updates and deletion during generation do not cancel accepted work or resurrect configuration", async t => {
  const f = await fixture({ accountCount: 1, allowFailover: false, turns: ["Accepted work completed"] });
  const release = holdTurns(f, t);
  const pending = f.api("/v1/chat/completions", { method: "POST", body: chat, headers: { "X-Session-ID": "deleted-account-session" } });
  await until(() => f.seen.length === 1);
  const patch = await f.admin("accounts/acc-0", { method: "PATCH", body: { label: "Updated while generating" } });
  assert.equal(patch.status, 200); await patch.text();
  assert.equal(f.store.data.accounts[0].label, "Updated while generating");
  assert.equal(f.app.overview().metrics.active, 1);
  const removed = await f.admin("accounts/acc-0", { method: "DELETE" });
  assert.equal(removed.status, 200); await removed.text();
  assert.equal(f.store.data.accounts.length, 0); assert.equal(f.app.overview().metrics.active, 1);
  release();
  const completed = await pending; assert.equal(completed.status, 200);
  assert.equal((await completed.json()).choices[0].message.content, "Accepted work completed");
  assert.equal(f.store.data.accounts.length, 0); assert.equal(f.app.pool.runtime.has("acc-0"), false);
  assert.equal(f.app.pool.listSessions()[0].accountId, null);
  const later = await f.api("/v1/chat/completions", { method: "POST", body: chat });
  assert.equal(later.status, 503); assert.equal((await later.json()).error.code, "NO_AVAILABLE_ACCOUNTS");
  assert.equal(f.seen.length, 1);
});
