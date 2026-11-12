import test from "node:test";
import assert from "node:assert/strict";
import { runNativeSearchDiagnostic } from "../src/gateway/native-search-diagnostic.mjs";
import { buildConsumerToolInitial } from "../native-wire/consumer-tool-codec.mjs";
import {
  parse,
  lengthDelimited as m,
  varintField as v,
} from "../native-wire/protobuf.mjs";

const fixed = {
  userText: "q",
  clientMetadata: {
    clientType: 21,
    languageCode: "en",
    interfaceLanguageCode: "en",
    clientVersion: "fixture",
    clientInstanceId: "fixed",
    triggerType: 1,
    uiSource: 1,
  },
};
const textFrame = (text = "Synthetic answer", mode = 8, thinking = 2) =>
  m(
    1003,
    m(
      1,
      Buffer.concat([
        m(
          1,
          Buffer.concat([
            m(1, Buffer.from("synthetic-response")),
            m(2, m(1, Buffer.from(text))),
          ]),
        ),
        v(9, 1),
        v(11, 0),
        v(31, 0),
        v(41, mode),
        v(42, thinking),
      ]),
    ),
  );
const synthetic = (events) => ({
  cancel() {},
  events: (async function* () {
    yield* events;
  })(),
});
const run = (options = {}) =>
  runNativeSearchDiagnostic({
    getAccessToken: async () => "fixture-token",
    query: "public query",
    openTurn: () =>
      synthetic([
        { type: "frame", bytes: textFrame() },
        { type: "end", httpStatus: 200, grpcStatus: 0 },
      ]),
    ...options,
  });

test("native permission changes only field 15 with fixed inputs; defaults and invalid combinations", () => {
  const baseline = buildConsumerToolInitial(fixed);
  const enabled = buildConsumerToolInitial({
    ...fixed,
    allowNativeTools: true,
  });
  const template = (bytes) =>
    parse(
      parse(parse(bytes).find((f) => f.number === 1000).payload).find(
        (f) => f.number === 1001,
      ).payload,
    ).find((f) => f.number === 1).payload;
  const fields = (bytes) =>
    parse(bytes).map((f) => [f.number, f.wire, [...f.raw]]);
  assert.deepEqual(
    fields(template(baseline)).filter((f) => f[0] !== 15),
    fields(template(enabled)).filter((f) => f[0] !== 15),
  );
  assert.equal(
    parse(template(baseline)).find((f) => f.number === 15).payload[0],
    1,
  );
  assert.equal(
    parse(template(enabled)).find((f) => f.number === 15).payload[0],
    0,
  );
  assert.throws(
    () => buildConsumerToolInitial({ userText: "q", allowNativeTools: 1 }),
    { code: "INVALID_NATIVE_TOOLS_PERMISSION" },
  );
  assert.throws(
    () =>
      buildConsumerToolInitial({
        userText: "q",
        allowNativeTools: true,
        tools: [{ type: "function", function: { name: "f" } }],
      }),
    { code: "NATIVE_TOOLS_WITH_DECLARATIONS" },
  );
});

test("uses provider validation and forwards only diagnostic query plus explicit permission", async () => {
  let observed;
  const report = await run({
    allowNativeTools: true,
    openTurn(token, options) {
      observed = { token, options };
      return synthetic([
        { type: "frame", bytes: textFrame() },
        { type: "end", httpStatus: 200, grpcStatus: 0 },
      ]);
    },
  });
  assert.equal(observed.options.messages[0].content, "public query");
  assert.equal(observed.options.allowNativeTools, true);
  assert.equal(observed.options.modeCategory, 8);
  assert.equal(observed.options.thinkingLevel, 2);
  assert.equal(observed.options.temporaryChat, true);
  assert.equal(report.ok, true);
  assert.equal(report.nativeToolsRequested, true);
  assert.equal(report.searchExecuted, null);
});

test("permission defaults false and diagnostic query has no tool-prohibition instruction", async () => {
  let observed;
  const report = await run({
    openTurn(_token, options) {
      observed = options;
      return synthetic([
        { type: "frame", bytes: textFrame() },
        { type: "end", httpStatus: 200, grpcStatus: 0 },
      ]);
    },
  });
  assert.equal(observed.allowNativeTools, false);
  assert.deepEqual(observed.messages, [
    { role: "user", content: "public query" },
  ]);
  assert.equal(report.nativeToolsRequested, false);
});

test("input validation and pre-abort happen before authentication", async () => {
  let authCalls = 0;
  const getAccessToken = async () => {
    authCalls++;
    return "fixture";
  };
  const controller = new AbortController();
  controller.abort();
  const base = { getAccessToken, openTurn: () => synthetic([]), query: "q" };
  assert.equal(
    (await runNativeSearchDiagnostic({ ...base, signal: controller.signal }))
      .errorCode,
    "NATIVE_TURN_ABORTED",
  );
  assert.equal(
    (await runNativeSearchDiagnostic({ ...base, timeoutMs: 180001 })).errorCode,
    "INVALID_DIAGNOSTIC_INPUT",
  );
  assert.equal(authCalls, 0);
});

test("auth and read deadlines preserve safe provider codes and withhold metadata", async () => {
  const auth = await runNativeSearchDiagnostic({
    getAccessToken: () => new Promise(() => {}),
    openTurn: () => {
      throw Error("must not open");
    },
    query: "q",
    timeoutMs: 10,
  });
  assert.equal(auth.errorCode, "NATIVE_TURN_TIMEOUT");
  const waiting = await runNativeSearchDiagnostic({
    getAccessToken: async () => "fixture",
    openTurn: () => ({
      cancel() {},
      events: (async function* () {
        await new Promise(() => {});
      })(),
    }),
    query: "q",
    timeoutMs: 10,
  });
  assert.equal(waiting.errorCode, "NATIVE_TURN_TIMEOUT");
  assert.deepEqual(waiting.citations, []);
});

test("provider stops reject missing completion, downgrade, wrong thinking and native operations", async () => {
  for (const [events, code] of [
    [
      [{ type: "end", httpStatus: 200, grpcStatus: 0 }],
      "INCOMPLETE_NATIVE_RESPONSE",
    ],
    [
      [
        { type: "frame", bytes: textFrame("answer", 9, 2) },
        { type: "end", httpStatus: 200, grpcStatus: 0 },
      ],
      "MODEL_DOWNGRADE_REJECTED",
    ],
    [
      [
        { type: "frame", bytes: textFrame("answer", 8, 1) },
        { type: "end", httpStatus: 200, grpcStatus: 0 },
      ],
      "NATIVE_THINKING_MISMATCH",
    ],
    [
      [
        {
          type: "frame",
          bytes: m(
            1003,
            m(1, Buffer.concat([v(9, 1), v(41, 8), m(7, Buffer.alloc(0))])),
          ),
        },
        { type: "end", httpStatus: 200, grpcStatus: 0 },
      ],
      "UNSUPPORTED_NATIVE_TOOL_EVENT",
    ],
  ]) {
    const report = await run({ openTurn: () => synthetic(events) });
    assert.equal(report.ok, false);
    assert.equal(report.errorCode, code);
    assert.deepEqual(report.webSources, []);
  }
});

test("duplicate wrapper fields and oversized response fail closed", async () => {
  const duplicate = Buffer.concat([textFrame(), m(1003, Buffer.alloc(0))]);
  const bad = await run({
    openTurn: () =>
      synthetic([
        { type: "frame", bytes: duplicate },
        { type: "end", httpStatus: 200, grpcStatus: 0 },
      ]),
  });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.citations, []);
  const large = await run({
    openTurn: () =>
      synthetic([{ type: "frame", bytes: Buffer.alloc(1024 * 1024 + 1) }]),
  });
  assert.equal(large.errorCode, "NATIVE_RESPONSE_LIMIT");
});

test("transport status codes are preserved and failure never releases metadata", async () => {
  const report = await run({
    openTurn: () =>
      synthetic([
        { type: "frame", bytes: textFrame() },
        { type: "end", httpStatus: 429, grpcStatus: 8 },
      ]),
  });
  assert.equal(report.errorCode, "NATIVE_RATE_LIMITED");
  assert.equal(report.stopRound, true);
  assert.deepEqual(report.citations, []);
});
test("validated metadata is retained only after provider completion; reset withholds it", async () => {
  const citation = m(6, m(3, Buffer.from("https://example.org/source")));
  const inner = Buffer.concat([
    m(1, Buffer.from("synthetic-response")),
    m(2, m(1, Buffer.from("Synthetic answer"))),
    citation,
  ]);
  const frame = m(
    1003,
    m(
      1,
      Buffer.concat([
        m(1, inner),
        v(9, 1),
        v(11, 0),
        v(31, 0),
        v(41, 8),
        v(42, 2),
      ]),
    ),
  );
  const valid = await run({
    openTurn: () =>
      synthetic([
        { type: "frame", bytes: frame },
        { type: "end", httpStatus: 200, grpcStatus: 0 },
      ]),
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.citationCount, 1);
  assert.equal(valid.citations[0].frameIndex, 1);
  async function* resetAfterComplete() {
    yield { type: "frame", bytes: frame };
    throw Object.assign(new Error(), { code: "NATIVE_STREAM_RESET" });
  }
  const reset = await run({
    openTurn: () => ({ cancel() {}, events: resetAfterComplete() }),
  });
  assert.equal(reset.errorCode, "NATIVE_STREAM_RESET");
  assert.deepEqual(reset.citations, []);
});
test("caller abort and aggregate metadata limits withhold diagnostic results", async () => {
  const controller = new AbortController();
  const pending = run({
    signal: controller.signal,
    openTurn: () => ({
      cancel() {},
      events: (async function* () {
        await new Promise(() => {});
      })(),
    }),
  });
  controller.abort();
  const aborted = await pending;
  assert.equal(aborted.errorCode, "NATIVE_TURN_ABORTED");
  const citation = m(6, m(3, Buffer.from("https://example.org/source")));
  const frame = m(
    1003,
    m(
      1,
      Buffer.concat([
        m(
          1,
          Buffer.concat([
            m(1, Buffer.from("synthetic-response")),
            m(2, m(1, Buffer.from("Synthetic answer"))),
            ...Array(64).fill(citation),
          ]),
        ),
        v(9, 1),
        v(11, 0),
        v(31, 0),
        v(41, 8),
        v(42, 2),
      ]),
    ),
  );
  const events = [
    ...Array(5).fill({ type: "frame", bytes: frame }),
    { type: "end", httpStatus: 200, grpcStatus: 0 },
  ];
  const limited = await run({ openTurn: () => synthetic(events) });
  assert.equal(limited.errorCode, "NATIVE_METADATA_LIMIT");
  assert.deepEqual(limited.citations, []);
});

test("precondition and credential failures stop the diagnostic round", async () => {
  const rejected = await run({
    openTurn: () =>
      synthetic([{ type: "end", httpStatus: 200, grpcStatus: 9 }]),
  });
  assert.equal(rejected.errorCode, "NATIVE_PRECONDITION_REQUIRED");
  assert.equal(rejected.stopRound, true);
  for (const code of ["ACCOUNT_LOGIN_REQUIRED", "OAUTH_REFRESH_FAILED"]) {
    let opened = false;
    const report = await run({
      getAccessToken: async () => {
        throw Object.assign(new Error("private"), { code });
      },
      openTurn: () => {
        opened = true;
        return synthetic([]);
      },
    });
    assert.equal(report.errorCode, code);
    assert.equal(report.stopRound, true);
    assert.equal(opened, false);
    assert.deepEqual(report.citations, []);
  }
});
