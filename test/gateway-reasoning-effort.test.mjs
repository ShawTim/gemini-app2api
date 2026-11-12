import test from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import {
  REASONING_EFFORT_LEVELS,
  normalizeChatRequest,
  normalizeResponsesRequest,
  buildCanonicalPrompt,
} from "../src/openai-contract.mjs";
import {
  fixture,
  tools,
  responseTools,
  toolBlock,
} from "./gateway-fixture.mjs";
const message = { role: "user", content: "Answer the public test question." };
const input = (api) =>
  api === "chat" ? { messages: [message] } : { input: [message] };
const effortInput = (api, effort) =>
  api === "chat" ? { reasoning_effort: effort } : { reasoning: { effort } };
const normalize = (api, body) =>
  api === "chat"
    ? normalizeChatRequest(body)
    : normalizeResponsesRequest(body).body;
const endpoint = (api) =>
  api === "chat" ? "/v1/chat/completions" : "/v1/responses";
function completed(raw, api, stream) {
  if (!stream) return JSON.parse(raw);
  const rows = raw
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
  if (api === "chat") {
    assert.equal(rows.at(-1), "[DONE]");
    return JSON.parse(rows.at(-2));
  }
  const last = JSON.parse(rows.at(-1));
  assert.equal(last.type, "response.completed");
  return last.response;
}
function assertEcho(data, api, effort) {
  assert.equal(
    api === "chat" ? data.reasoning_effort : data.reasoning.effort,
    effort,
  );
}

test("six effort names map explicitly and survive canonical re-normalization on both APIs/models", () => {
  assert.deepEqual(REASONING_EFFORT_LEVELS, {
    none: 0,
    minimal: 0,
    low: 1,
    medium: 2,
    high: 2,
    xhigh: 2,
  });
  for (const api of ["chat", "responses"])
    for (const model of ["gemini-argon", "gemini-hydrogen", "gemini-flash-lite"])
      for (const [effort, level] of Object.entries(REASONING_EFFORT_LEVELS)) {
        const canonical = normalize(api, {
          ...input(api),
          model,
          ...effortInput(api, effort),
        });
        assert.equal(canonical.thinking_level, level);
        assert.equal(canonical.model, model);
        assert.deepEqual(normalizeChatRequest(canonical), canonical);
        const direct = normalizeChatRequest({
          messages: [message],
          model,
          thinking_level: level,
        });
        assert.deepEqual(
          buildCanonicalPrompt(canonical),
          buildCanonicalPrompt(direct),
        );
      }
});
test("defaults, legacy no-summary configuration and explicit numeric levels stay unchanged", () => {
  for (const api of ["chat", "responses"]) {
    assert.equal(normalize(api, input(api)).thinking_level, 2);
    assert.equal(
      normalize(api, { ...input(api), reasoning: {} }).thinking_level,
      2,
    );
    assert.equal(
      normalize(api, { ...input(api), reasoning: { summary: "none" } })
        .thinking_level,
      2,
    );
    for (const level of [0, 1, 2, 4])
      assert.equal(
        normalize(api, { ...input(api), thinking_level: level }).thinking_level,
        level,
      );
    const c = normalize(api, {
      ...input(api),
      reasoning_effort: "high",
      reasoning: { effort: "high", summary: "none" },
      thinking_level: 2,
    });
    assert.equal(c.thinking_level, 2);
    assert.equal(
      normalize(api, {
        ...input(api),
        reasoning_effort: "none",
        reasoning: { effort: "minimal" },
        thinking_level: 0,
      }).thinking_level,
      0,
    );
  }
});
test("invalid effort names/types, ambiguous controls and unsupported reasoning remain explicit failures", () => {
  for (const api of ["chat", "responses"]) {
    for (const effort of [
      "",
      "HIGH",
      "max",
      "default",
      "auto",
      " high",
      null,
      0,
      false,
      {},
      [],
      "__proto__",
      "constructor",
    ]) {
      for (const fields of [
        { reasoning_effort: effort },
        { reasoning: { effort } },
      ])
        assert.throws(
          () => normalize(api, { ...input(api), ...fields }),
          (e) => e.code === "INVALID_REASONING_EFFORT",
        );
    }
    for (const fields of [
      { reasoning_effort: "high", thinking_level: 1 },
      { reasoning: { effort: "low" }, thinking_level: 3 },
      { reasoning_effort: "low", reasoning: { effort: "high" } },
    ])
      assert.throws(
        () => normalize(api, { ...input(api), ...fields }),
        (e) => e.code === "CONFLICTING_THINKING_SETTINGS",
      );
    for (const reasoning of [
      null,
      [],
      "high",
      ...(api === "chat" ? [{ effort: "medium", summary: "auto" }] : []),
      { effort: "medium", unexpected: true },
      { effort: "medium", generate_summary: true },
    ])
      assert.throws(() => normalize(api, { ...input(api), reasoning }));
    for (const level of [-1, 5, null, "2", 1.5])
      assert.throws(
        () =>
          normalize(api, {
            ...input(api),
            reasoning_effort: "medium",
            thinking_level: level,
          }),
        (e) => e.code === "INVALID_THINKING_LEVEL",
      );
  }
});
test("native search permits only effort resolving to its already-supported level2", () => {
  for (const api of ["chat", "responses"]) {
    assert.equal(
      normalize(api, {
        ...input(api),
        native_search: true,
        ...effortInput(api, "medium"),
      }).thinking_level,
      2,
    );
    for (const effort of ["none", "minimal", "low"])
      assert.throws(
        () =>
          normalize(api, {
            ...input(api),
            native_search: true,
            ...effortInput(api, effort),
          }),
        (e) => e.code === "UNSUPPORTED_NATIVE_SEARCH_MODE",
      );
  }
});
test("all efforts reach actual provider options with honest JSON/SSE echoes and requested/resolved headers", async (t) => {
  const f = await fixture({
    turns: Array(24).fill("Synthetic effort answer"),
    allowFailover: false,
  });
  t.after(f.close);
  let index = 0;
  for (const api of ["chat", "responses"])
    for (const stream of [false, true])
      for (const [effort, level] of Object.entries(REASONING_EFFORT_LEVELS)) {
        const r = await f.api(endpoint(api), {
          method: "POST",
          body: { ...input(api), ...effortInput(api, effort), stream },
        });
        assert.equal(r.status, 200);
        assert.equal(f.seen[index++].thinkingLevel, level);
        assert.equal(r.headers.get("x-reasoning-effort"), effort);
        assert.equal(
          r.headers.get("x-requested-thinking-level"),
          String(level),
        );
        assert.equal(r.headers.get("x-thinking-level"), String(level));
        const data = completed(await r.text(), api, stream);
        assertEcho(data, api, effort);
        assert.equal(data.model, "gemini-argon");
      }
});
test("upstream mismatch remains resolved evidence, never relabelled as requested high", async (t) => {
  const f = await fixture({
    turns: Array.from({ length: 4 }, () => ({
      text: "Synthetic lower resolved level",
      thinking: 1,
    })),
    allowFailover: false,
  });
  t.after(f.close);
  for (const api of ["chat", "responses"])
    for (const stream of [false, true]) {
      const r = await f.api(endpoint(api), {
        method: "POST",
        body: { ...input(api), ...effortInput(api, "high"), stream },
      });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("x-requested-thinking-level"), "2");
      assert.equal(r.headers.get("x-thinking-level"), "1");
      assert.equal(r.headers.get("x-reasoning-effort"), "high");
      assertEcho(completed(await r.text(), api, stream), api, "high");
    }
  assert.ok(f.seen.every((options) => options.thinkingLevel === 2));
});
test("invalid and conflicting HTTP inputs fail before account/provider use", async (t) => {
  const f = await fixture({ allowFailover: false });
  t.after(f.close);
  for (const api of ["chat", "responses"])
    for (const fields of [
      { reasoning_effort: "unknown" },
      { reasoning: { effort: null } },
      { reasoning_effort: "high", thinking_level: 1 },
      { reasoning_effort: "low", reasoning: { effort: "high" } },
    ]) {
      const r = await f.api(endpoint(api), {
        method: "POST",
        body: { ...input(api), ...fields },
      });
      assert.equal(r.status, 400);
      const raw = await r.text();
      assert.match(
        JSON.parse(raw).error.code,
        /INVALID_REASONING_EFFORT|CONFLICTING_THINKING_SETTINGS/,
      );
      assert.equal(r.headers.get("x-reasoning-effort"), null);
      assert.doesNotMatch(raw, /response\.completed|data:/);
    }
  assert.equal(f.seen.length, 0);
});
test("effort control and original function-call linkage survive full replay", async (t) => {
  for (const api of ["chat", "responses"]) {
    const f = await fixture({
      turns: [toolBlock, "Synthetic linked result used"],
      allowFailover: false,
    });
    t.after(f.close);
    const common = {
      ...effortInput(api, "high"),
      tools: api === "chat" ? tools : responseTools,
    };
    const first = await f.api(endpoint(api), {
      method: "POST",
      body: { ...input(api), ...common, tool_choice: "required" },
    });
    assert.equal(first.status, 200);
    const data = await first.json();
    let continuation;
    if (api === "chat") {
      const assistant = data.choices[0].message,
        call = assistant.tool_calls[0];
      continuation = {
        messages: [
          message,
          assistant,
          {
            role: "tool",
            tool_call_id: call.id,
            content: "Synthetic actual caller result",
          },
        ],
      };
    } else {
      const call = data.output.find((x) => x.type === "function_call");
      continuation = {
        input: [
          message,
          ...data.output,
          {
            type: "function_call_output",
            call_id: call.call_id,
            output: "Synthetic actual caller result",
          },
        ],
      };
    }
    const last = await f.api(endpoint(api), {
      method: "POST",
      body: { ...continuation, ...common, tool_choice: "none" },
    });
    assert.equal(last.status, 200);
    assertEcho(await last.json(), api, "high");
    assert.equal(f.seen.length, 2);
    assert.ok(f.seen.every((o) => o.thinkingLevel === 2));
    assert.match(
      f.seen[1].messages[0].content,
      /Synthetic actual caller result/,
    );
  }
});

test("official OpenAI JS client uses native Chat and Responses effort fields without preprocessing", async (t) => {
  const f = await fixture({
    turns: ["SDK chat answer", "SDK Responses answer"],
    allowFailover: false,
  });
  t.after(f.close);
  const client = new OpenAI({
    apiKey: f.key.key,
    baseURL: f.base + "/v1",
    maxRetries: 0,
  });
  const chat = await client.chat.completions
    .create({
      model: "gemini-argon",
      messages: [message],
      reasoning_effort: "high",
    })
    .withResponse();
  assert.equal(chat.data.reasoning_effort, "high");
  assert.equal(chat.response.headers.get("x-requested-thinking-level"), "2");
  const responses = await client.responses
    .create({
      model: "gemini-argon",
      input: message.content,
      reasoning: { effort: "xhigh" },
    })
    .withResponse();
  assert.equal(responses.data.reasoning.effort, "xhigh");
  assert.equal(
    responses.response.headers.get("x-requested-thinking-level"),
    "2",
  );
  assert.deepEqual(
    f.seen.map((options) => options.thinkingLevel),
    [2, 2],
  );
});
