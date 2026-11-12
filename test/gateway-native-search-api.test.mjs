import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway } from "../src/gateway/app.mjs";
import { StateStore } from "../src/gateway/state.mjs";
import { Accounts } from "../src/gateway/accounts.mjs";
import {
  lengthDelimited as m,
  varintField as v,
} from "../native-wire/protobuf.mjs";
import {
  normalizeChatRequest,
  normalizeResponsesRequest,
  buildCanonicalPrompt,
} from "../src/openai-contract.mjs";
const str = (n, value) => m(n, Buffer.from(value));
const frame = ({
  text = "Final source https://example.org/",
  tool = "google",
  complete = true,
  mode = 8,
  id = "synthetic-response",
} = {}) => ({
  type: "frame",
  bytes: m(
    1003,
    m(
      1,
      Buffer.concat([
        m(1, Buffer.concat([str(1, id), m(2, str(1, text))])),
        v(9, Number(complete)),
        v(41, mode),
        v(42, 2),
        ...(tool ? [m(8, m(2, Buffer.concat([str(1, tool), v(3, 4)])))] : []),
      ]),
    ),
  ),
});
const end = { type: "end", httpStatus: 200, grpcStatus: 0 };
async function setup(t, events = [frame({ text: "draft" }), frame(), end]) {
  const directory = fs.mkdtempSync(
    path.join(
      process.env.PI_SCRATCH_DIR || fs.realpathSync(os.tmpdir()),
      "native-api-fixture-",
    ),
  );
  const store = new StateStore({
    directory,
    adminPassword: "synthetic-search-api-password",
  });
  store.data.profile = {
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    scopes: [],
  };
  store.data.accounts = [
    {
      id: "acc-synthetic",
      enabled: true,
      status: "ready",
      refreshToken: "synthetic-refresh",
    },
  ];
  store.save();
  const seen = [];
  const app = createGateway({
    store,
    allowFailover: false,
    accounts: new Accounts(store, {
      refresh: async () => ({
        accessToken: "synthetic-token",
        expiresInSeconds: 3600,
      }),
    }),
    openTurn: (_token, options) => {
      seen.push(options);
      return {
        cancel() {},
        events: (async function* () {
          for (const event of events) {
            if (event instanceof Error) throw event;
            yield event;
          }
        })(),
      };
    },
  });
  const base = await app.listen({ host: "127.0.0.1", port: 0 }),
    key = store.createKey("synthetic");
  t.after(async () => {
    await app.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    seen,
    request: (api, body) =>
      fetch(
        base + (api === "chat" ? "/v1/chat/completions" : "/v1/responses"),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + key.key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      ),
  };
}
const body = (api, stream = false, extra = {}) => ({
  model: "gemini-argon",
  thinking_level: 2,
  native_search: true,
  stream,
  ...(api === "chat"
    ? {
        messages: [
          { role: "system", content: "Keep source URLs." },
          { role: "user", content: "Find public sources." },
        ],
      }
    : { instructions: "Keep source URLs.", input: "Find public sources." }),
  ...extra,
});
for (const api of ["chat", "responses"])
  for (const stream of [false, true])
    test(`native search HTTP ${api} ${stream ? "SSE" : "JSON"} preserves validated answer and typed evidence`, async (t) => {
      const f = await setup(t),
        r = await f.request(api, body(api, stream));
      assert.equal(r.status, 200);
      assert.equal(f.seen.length, 1);
      assert.equal(f.seen[0].allowNativeTools, true);
      assert.equal(f.seen[0].modeCategory, 8);
      assert.equal(f.seen[0].thinkingLevel, 2);
      assert.match(f.seen[0].messages[0].content, /Keep source URLs/);
      const raw = await r.text();
      assert.doesNotMatch(
        raw,
        /synthetic-response|"tool_calls"|"function_call"|"web_search_call"/,
      );
      let result;
      if (!stream) result = JSON.parse(raw);
      else {
        const events = raw
          .split("\n")
          .filter((x) => x.startsWith("data: "))
          .map((x) => x.slice(6));
        if (api === "chat") {
          assert.equal(events.at(-1), "[DONE]");
          const objects = events.slice(0, -1).map(JSON.parse);
          assert.equal(objects.filter((x) => x.native_search).length, 1);
          result = objects.find((x) => x.native_search);
        } else {
          const objects = events.map(JSON.parse);
          assert.equal(objects.at(-1).type, "response.completed");
          result = objects.at(-1).response;
        }
      }
      assert.equal(result.native_search.googleToolReported, true);
      assert.equal(result.native_search.provider, "gemini");
      assert.equal(result.native_search.revisionCount, 1);
      assert.equal(result.native_search.structuredCitationCount, 0);
      assert.match(raw, /Final source https/);
    });
test("native opt-in rejects mixed tools/history, invalid modes/types and oversize before transport", async (t) => {
  const f = await setup(t);
  for (const extra of [
    { native_search: "true" },
    { model: "gemini-flash-lite" },
    { model: "gemini-flash" },
    { thinking_level: 1 },
    { tool_choice: "none" },
    { parallel_tool_calls: false },
    { tools: [{ type: "function", function: { name: "x" } }] },
    { messages: [{ role: "tool", tool_call_id: "x", content: "x" }] },
    { messages: [{ role: "user", content: "x".repeat(16384) }] },
  ]) {
    const r = await f.request("chat", body("chat", false, extra));
    assert.ok(r.status >= 400 && r.status < 500);
    await r.text();
  }
  assert.equal(f.seen.length, 0);
  assert.throws(() =>
    normalizeResponsesRequest({
      input: "q",
      native_search: true,
      tools: [{ type: "web_search" }],
    }),
  );
  assert.throws(() =>
    normalizeResponsesRequest({
      native_search: true,
      input: [
        {
          type: "function_call",
          name: "x",
          call_id: "call_x",
          arguments: "{}",
        },
        { type: "function_call_output", call_id: "call_x", output: "x" },
      ],
    }),
  );
});
test("ordinary/default false requests retain original prompt and do not request native permission", async (t) => {
  const payload = { messages: [{ role: "user", content: "plain" }] };
  assert.deepEqual(
    normalizeChatRequest({ ...payload, native_search: false }),
    normalizeChatRequest(payload),
  );
  assert.deepEqual(
    buildCanonicalPrompt(
      normalizeChatRequest({ ...payload, native_search: false }),
    ),
    buildCanonicalPrompt(normalizeChatRequest(payload)),
  );
  const f = await setup(t, [frame({ tool: null }), end]);
  const r = await f.request("chat", { ...payload, native_search: false });
  assert.equal(r.status, 200);
  assert.equal(f.seen[0].allowNativeTools, undefined);
  assert.equal((await r.json()).native_search, undefined);
});
test("missing Google evidence, other tools and reset/permission failures withhold success JSON and SSE", async (t) => {
  const cases = [
    [[frame({ tool: null }), end], "NATIVE_SEARCH_NOT_OBSERVED"],
    [
      [frame({ tool: "other-private-tool" }), end],
      "UNSUPPORTED_NATIVE_TOOL_REPORT",
    ],
    [
      [
        frame(),
        Object.assign(Error("private"), { code: "NATIVE_STREAM_RESET" }),
      ],
      "NATIVE_STREAM_RESET",
    ],
    [[frame(), { ...end, grpcStatus: 9 }], "NATIVE_PRECONDITION_REQUIRED"],
    [[frame({ mode: 6 }), end], "MODEL_DOWNGRADE_REJECTED"],
  ];
  for (const [events, code] of cases)
    for (const api of ["chat", "responses"]) {
      const f = await setup(t, events),
        r = await f.request(api, body(api, true));
      assert.equal(r.status, 502);
      assert.match(r.headers.get("content-type"), /application\/json/);
      const raw = await r.text();
      assert.equal(JSON.parse(raw).error.code, code);
      assert.doesNotMatch(
        raw,
        /Final source|other-private-tool|googleToolReported|response\.completed|data:/,
      );
      assert.equal(f.seen.length, 1);
    }
});

test("native search medium effort keeps requested echo and level2 restriction", async (t) => {
  for (const api of ["chat", "responses"]) {
    const f = await setup(t);
    const request = body(api);
    delete request.thinking_level;
    Object.assign(
      request,
      api === "chat"
        ? { reasoning_effort: "medium" }
        : { reasoning: { effort: "medium" } },
    );
    const response = await f.request(api, request);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-requested-thinking-level"), "2");
    assert.equal(response.headers.get("x-thinking-level"), "2");
    assert.equal(response.headers.get("x-reasoning-effort"), "medium");
    assert.equal(f.seen[0].thinkingLevel, 2);
    const data = await response.json();
    assert.equal(data.native_search.googleToolReported, true);
    assert.equal(
      api === "chat" ? data.reasoning_effort : data.reasoning.effort,
      "medium",
    );
  }
});
