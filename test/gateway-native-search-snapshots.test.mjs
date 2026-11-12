import test from "node:test";
import assert from "node:assert/strict";
import { NativeDirectProvider } from "../src/native-provider.mjs";
import { runNativeSearchDiagnostic } from "../src/gateway/native-search-diagnostic.mjs";
import {
  lengthDelimited as m,
  varintField as v,
} from "../native-wire/protobuf.mjs";
const s = (n, text) => m(n, Buffer.from(text));
const frame = ({
  id = "synthetic-private-response-id",
  text = "final answer",
  complete = true,
  mode = 8,
  googleFinal = false,
  googleStatus = false,
  extra = [],
} = {}) => ({
  type: "frame",
  bytes: m(
    1003,
    m(
      1,
      Buffer.concat([
        m(
          1,
          Buffer.concat([...(id === null ? [] : [s(1, id)]), m(2, s(1, text))]),
        ),
        v(9, Number(complete)),
        v(41, mode),
        v(42, 2),
        ...(googleStatus
          ? [m(6, m(2, Buffer.concat([s(1, "google"), v(3, 1)])))]
          : []),
        ...(googleFinal
          ? [m(8, m(2, Buffer.concat([s(1, "google"), v(3, 4)])))]
          : []),
        ...extra,
      ]),
    ),
  ),
});
const end = { type: "end", httpStatus: 200, grpcStatus: 0 };
function turn(events) {
  return {
    cancel() {},
    events: (async function* () {
      for (const e of events) {
        if (e instanceof Error) throw e;
        yield e;
      }
    })(),
  };
}
const body = {
  model: "gemini-argon",
  messages: [{ role: "user", content: "public query" }],
  thinking_level: 2,
};
function provider(events, enabled) {
  return new NativeDirectProvider(
    { getValidAccessToken: async () => "synthetic" },
    { openTurn: () => turn(events), allowTextSnapshotReplacement: enabled },
  );
}
const diag = (events) =>
  runNativeSearchDiagnostic({
    getAccessToken: async () => "synthetic",
    openTurn: () => turn(events),
    query: "public query",
    allowNativeTools: true,
  });

test("same-ID whole-text revisions are buffered by default until validated terminal", async () => {
  const events = [
    frame({ text: "draft" }),
    frame({ text: "final answer" }),
    end,
  ];
  const ordinary = await provider(events, false).runTurn('fixture', body);
  assert.equal(ordinary.content, 'final answer'); assert.equal(ordinary.revisionCount, 1);
  const output = [];
  const result = await provider(events, true).runTurn("fixture", body, (x) =>
    output.push(x),
  );
  assert.equal(result.content, "final answer");
  assert.equal(result.revisionCount, 1);
  assert.deepEqual(output, [{ content: "final answer" }]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /synthetic-private-response-id|draft/,
  );
});
test("snapshot mode rejects missing, changed or duplicate response identity and missing terminal", async () => {
  for (const events of [
    [frame({ id: null }), end],
    [frame(), frame({ id: "changed" }), end],
    [frame()],
    [frame({ extra: [m(1, s(1, "duplicate-model"))] }), end],
  ]) {
    let emitted = 0;
    await assert.rejects(
      provider(events, true).runTurn("fixture", body, () => emitted++),
    );
    assert.equal(emitted, 0);
  }
});
test("snapshot mode requires explicit model completion, rejects downgrade and reset after revision", async () => {
  for (const [events, code] of [
    [[frame({ complete: false }), end], "INCOMPLETE_NATIVE_RESPONSE"],
    [
      [frame({ text: "draft" }), frame({ mode: 6 }), end],
      "MODEL_DOWNGRADE_REJECTED",
    ],
    [
      [
        frame({ text: "draft" }),
        frame(),
        Object.assign(Error("private"), { code: "NATIVE_STREAM_RESET" }),
      ],
      "NATIVE_STREAM_RESET",
    ],
  ]) {
    const report = await diag(events);
    assert.equal(report.ok, false);
    assert.equal(report.errorCode, code);
    assert.equal(report.answer, undefined);
    assert.deepEqual(report.citations, []);
    assert.equal(report.googleToolReported, undefined);
  }
});
test("snapshot opt-in rejects caller declarations before auth; no executable text accepted", async () => {
  let auth = 0;
  const p = new NativeDirectProvider(
    {
      getValidAccessToken: async () => {
        auth++;
        return "synthetic";
      },
    },
    {
      openTurn: () => turn([]),
      allowTextSnapshotReplacement: true,
      timeoutMs: 20,
    },
  );
  const tool = {
    type: "function",
    function: {
      name: "lookup",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  };
  await assert.rejects(
    p.runTurn("fixture", { ...body, tools: [tool] }),
    (e) => e.code === "NATIVE_TEXT_SNAPSHOT_TOOLS_FORBIDDEN",
  );
  assert.equal(auth, 0);
  const report = await diag([
    frame({ text: '```tool_call\n{"name":"lookup","arguments":{}}\n```' }),
    end,
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.answer, undefined);
});
test("typed Google final invocation is reported only with a fully validated answer", async () => {
  const report = await diag([
    frame({ text: "draft", googleStatus: true }),
    frame({ text: "final answer", googleFinal: true }),
    end,
  ]);
  assert.equal(report.ok, true);
  assert.equal(report.answer, "final answer");
  assert.equal(report.revisionCount, 1);
  assert.equal(report.googleToolReported, true);
  assert.equal(report.googleToolStatusCount, 2);
  assert.equal(report.googleFinalInvocationCount, 1);
  assert.equal(report.googleToolEvents[1].stateEnum, 4);
  assert.equal(report.searchExecuted, null);
  const statusOnly = await diag([frame({ googleStatus: true }), end]);
  assert.equal(statusOnly.ok, true);
  assert.equal(statusOnly.googleToolReported, false);
  const rejected = await diag([
    frame({ googleFinal: true }),
    { ...end, grpcStatus: 9 },
  ]);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.googleToolReported, undefined);
  assert.equal(rejected.answer, undefined);
});
test("Google status parsing rejects duplicate IDs, malformed wire and status-budget overflow", async () => {
  for (const extra of [
    [m(8, m(2, Buffer.concat([s(1, "google"), s(1, "other")])))],
    [v(8, 1)],
    Array(257).fill(m(8, m(2, s(1, "google")))),
  ]) {
    const report = await diag([frame({ extra }), end]);
    assert.equal(report.ok, false);
    assert.equal(report.answer, undefined);
  }
});
