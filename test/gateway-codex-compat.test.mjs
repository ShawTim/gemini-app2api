import test from "node:test";
import assert from "node:assert/strict";
import {
  NativeDirectProvider,
  normalizeChatRequest,
} from "../src/native-provider.mjs";
import {
  lengthDelimited as m,
  varintField as v,
} from "../native-wire/protobuf.mjs";
import { fixture } from "./gateway-fixture.mjs";

const tool = {
  type: "function",
  function: {
    name: "lookup",
    description: "lookup",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
};
const twoCalls =
  '```tool_call\n{"name":"lookup","arguments":{"key":"a"}}\n```\ntext\n```tool_call\n{"name":"lookup","arguments":{"key":"b"}}\n```';
const providerFor = (output) =>
  new NativeDirectProvider(
    { getValidAccessToken: async () => "synthetic" },
    {
      openTurn: (_token, options) => {
        const bytes = m(
          1003,
          m(
            1,
            Buffer.concat([
              m(1, m(2, m(1, Buffer.from(output)))),
              v(41, options.modeCategory),
              v(42, options.thinkingLevel),
              v(9, 1),
            ]),
          ),
        );
        return {
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: "frame", bytes };
              yield { type: "end", httpStatus: 200, grpcStatus: 0 };
            },
          },
          cancel() {},
        };
      },
    },
  );

test("parallel_tool_calls false rejects multiple new calls before callbacks or JSON/SSE output", async () => {
  for (const stream of [false, true]) {
    const body = normalizeChatRequest({
      messages: [{ role: "user", content: "hi" }],
      tools: [tool],
      parallel_tool_calls: false,
      stream,
    });
    let callbacks = 0;
    await assert.rejects(
      providerFor(twoCalls).runTurn("fixture", body, () => callbacks++),
      (error) => error.code === "PARALLEL_TOOL_CALLS_DISABLED",
    );
    assert.equal(callbacks, 0);
  }
});

test("parallel calls remain enabled by default and true; false only affects new calls, not replay history", async () => {
  const result = await providerFor(twoCalls).runTurn(
    "fixture",
    normalizeChatRequest({
      messages: [{ role: "user", content: "hi" }],
      tools: [tool],
    }),
  );
  assert.equal(result.calls.length, 2);
  const enabled = await providerFor(twoCalls).runTurn(
    "fixture",
    normalizeChatRequest({
      messages: [{ role: "user", content: "hi" }],
      tools: [tool],
      parallel_tool_calls: true,
    }),
  );
  assert.equal(enabled.calls.length, 2);
  const history = [
    { role: "user", content: "prior" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "prior_a",
          type: "function",
          function: { name: "lookup", arguments: '{"key":"a"}' },
        },
        {
          id: "prior_b",
          type: "function",
          function: { name: "lookup", arguments: '{"key":"b"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "prior_a", content: "a" },
    { role: "tool", tool_call_id: "prior_b", content: "b" },
  ];
  assert.equal(
    normalizeChatRequest({
      messages: [...history, { role: "user", content: "next" }],
      tools: [tool],
      parallel_tool_calls: false,
    }).messages[1].tool_calls.length,
    2,
  );
});

// Ordinary HTTP output is incremental: the first validated call is committed to
// the caller before the second block is parsed. The second call is never
// released; the turn ends as an explicit incomplete partial (no retry/splice).
test("real gateway releases at most one call with parallel_tool_calls false and marks the turn incomplete", async (t) => {
  for (const api of ["chat", "responses"])
    for (const stream of [false, true]) {
      const f = await fixture({ turns: [twoCalls], allowFailover: false });
      t.after(f.close);
      const body = {
        model: "gemini-argon",
        thinking_level: 2,
        parallel_tool_calls: false,
        stream,
        ...(api === "chat"
          ? { messages: [{ role: "user", content: "lookup" }], tools: [tool] }
          : {
              input: "lookup",
              tools: [{ type: "function", ...tool.function }],
            }),
      };
      const response = await fetch(
        f.base + (api === "chat" ? "/v1/chat/completions" : "/v1/responses"),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + f.key.key,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
      );
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.doesNotMatch(text, /\\"key\\":\\"b\\"/); // second call never released
      assert.equal((text.match(/\\"key\\":\\"a\\"/g) ?? []).length >= 1, true);
      if (!stream) {
        assert.match(response.headers.get("content-type"), /application\/json/);
        assert.equal(response.headers.get("x-gemini-incomplete"), "true");
        const payload = JSON.parse(text);
        assert.equal(payload.status, "incomplete");
        assert.equal(payload.error.code, "PARALLEL_TOOL_CALLS_DISABLED");
        assert.equal(payload.incomplete_details.code, "PARALLEL_TOOL_CALLS_DISABLED");
        if (api === "chat") {
          assert.equal(payload.choices[0].finish_reason, null);
          assert.equal(payload.choices[0].message.tool_calls.length, 1);
        } else {
          const calls = payload.output.filter((item) => item.type === "function_call");
          assert.equal(calls.length, 1);
          assert.ok(calls.every((item) => item.status === "incomplete"));
        }
      } else {
        assert.match(response.headers.get("content-type"), /text\/event-stream/);
        const events = text.split("\n\n").filter((e) => e.includes("data: {")).map((e) => JSON.parse(e.slice(e.indexOf("data: ") + 6)));
        if (api === "chat") {
          const calls = events.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? []);
          assert.equal(calls.length, 1);
          const final = events.at(-1);
          assert.equal(final.choices[0].finish_reason, "tool_calls");
          assert.equal(final.incomplete, true);
          assert.equal(final.incomplete_details.code, "PARALLEL_TOOL_CALLS_DISABLED");
          assert.match(text, /data: \[DONE\]\n\n$/);
        } else {
          const final = events.at(-1);
          assert.equal(final.type, "response.completed");
          assert.equal(final.incomplete, true);
          assert.equal(final.response.incomplete, true);
          assert.equal(final.response.error.code, "PARALLEL_TOOL_CALLS_DISABLED");
          assert.equal(final.response.parallel_tool_calls, false);
          assert.equal(final.response.output.filter((item) => item.type === "function_call").length, 1);
          assert.equal(events.filter((e) => e.type === "response.function_call_arguments.done").length, 1);
        }
      }
      const row = f.app.overview().requests[0];
      assert.equal(row.errorCode, "PARALLEL_TOOL_CALLS_DISABLED");
      assert.equal(row.toolCalls, 1);
      assert.equal(f.seen.length, 1); // committed output never triggers another generation
    }
});
