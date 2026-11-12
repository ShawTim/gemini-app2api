import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CALLER_CASES,
  createCallerCase,
  runCallerCase,
} from "../scripts/caller-tools-acceptance.mjs";
import { fixture } from "./gateway-fixture.mjs";
const callFor = (c, args = c.expectedArguments) => ({
  id: "call_synthetic",
  type: "function",
  function: { name: c.name, arguments: JSON.stringify(args) },
});
for (const name of CALLER_CASES) {
  test(`caller ${name} executes the isolated operation and verifies an actual result once`, (t) => {
    const c = createCallerCase(name);
    t.after(c.close);
    const executed = c.execute(callFor(c));
    assert.equal(executed.actionVerified, true);
    const text = JSON.stringify(executed.result);
    assert.equal(executed.verifyReply(text), true);
    assert.equal(executed.verifyReply("invented result"), false);
    if (name === "write")
      assert.equal(
        fs.readFileSync(path.join(c.directory, "write-output.txt"), "utf8"),
        c.expectedArguments.content,
      );
    if (name === "bash") {
      assert.equal(executed.result.exitCode, 0);
      assert.match(executed.result.stdout, /shell-ok\ntool_value_/);
    }
    if (name === "search") {
      assert.equal(executed.result.matches.length, 1);
      assert.equal(executed.result.matches[0].line, 2);
    }
    assert.throws(
      () => c.execute(callFor(c)),
      (e) => e.code === "CALLER_TOOL_ALREADY_EXECUTED",
    );
  });
  test(`actual fixture HTTP ${name} call, real caller execution and linked result-following`, async (t) => {
    const prototype = createCallerCase(name);
    t.after(prototype.close);
    const fence =
      "```tool_call\n" +
      JSON.stringify({ name, arguments: prototype.expectedArguments }) +
      "\n```";
    const f = await fixture({
      allowFailover: false,
      turns: [
        fence,
        (options) => {
          const text = options.messages[0].content;
          return [
            ...text.matchAll(/(?:caller_receipt_|tool_value_)[a-f0-9]{24}/g),
          ]
            .map((m) => m[0])
            .join(" ");
        },
      ],
    });
    t.after(f.close);
    const r = await runCallerCase({
      base: f.base,
      key: f.key.key,
      name,
      sourceHash: "synthetic-only",
    });
    assert.equal(r.verified, true);
    assert.equal(r.calls, 1);
    assert.equal(r.executions, 1);
    assert.equal(r.callerResultsSubmitted, 1);
    assert.equal(r.actionVerified, true);
    assert.equal(r.followedCallerResult, true);
    assert.deepEqual(r.httpStatuses, [200, 200]);
    assert.deepEqual(r.resolvedModes, [8, 8]);
    assert.equal(f.seen.length, 2);
    assert.doesNotMatch(
      JSON.stringify(r),
      /caller_receipt_|tool_value_|synthetic-refresh|Bearer|\/Users\//,
    );
  });
}
test("caller rejects path traversal, arbitrary shell, undeclared names and write overwrite", (t) => {
  for (const name of CALLER_CASES) {
    const c = createCallerCase(name);
    t.after(c.close);
    const bad = { ...c.expectedArguments };
    if (name === "bash") bad.command = "touch outside";
    else bad.path = "../outside";
    assert.throws(() => c.execute(callFor(c, bad)));
    const unknown = callFor(c);
    unknown.function.name = "undeclared";
    assert.throws(() => c.execute(unknown));
  }
  const c = createCallerCase("write");
  t.after(c.close);
  fs.writeFileSync(
    path.join(c.directory, "write-output.txt"),
    "existing synthetic data",
  );
  assert.throws(
    () => c.execute(callFor(c)),
    (e) => e.code === "EEXIST",
  );
  assert.equal(
    fs.readFileSync(path.join(c.directory, "write-output.txt"), "utf8"),
    "existing synthetic data",
  );
});
test("caller read refuses a symlink even at the expected fixture name", (t) => {
  const c = createCallerCase("read");
  t.after(c.close);
  const input = path.join(c.directory, "read-input.txt"),
    other = path.join(c.directory, "other.txt");
  fs.writeFileSync(other, "other synthetic");
  fs.unlinkSync(input);
  fs.symlinkSync(other, input);
  assert.throws(
    () => c.execute(callFor(c)),
    (e) => e.code === "UNSAFE_CALLER_FIXTURE",
  );
});
test("no-call upstream failure executes no local tool and native quota stops further cases", async (t) => {
  const f = await fixture({
    allowFailover: false,
    turns: [
      Object.assign(Error("private"), {
        code: "NATIVE_STREAM_RESET",
        status: 502,
      }),
    ],
  });
  t.after(f.close);
  const r = await runCallerCase({
    base: f.base,
    key: f.key.key,
    name: "write",
    sourceHash: "synthetic",
  });
  assert.equal(r.calls, 0);
  assert.equal(r.executions, 0);
  assert.equal(r.actionVerified, false);
  assert.equal(r.verified, false);
  assert.equal(r.errorCode, "GENERATION_FAILED");
  assert.equal(f.seen.length, 1);
  const q = await fixture({
    allowFailover: false,
    turns: [
      Object.assign(Error("private"), {
        code: "NATIVE_QUOTA_EXHAUSTED",
        status: 429,
      }),
    ],
  });
  t.after(q.close);
  const stopped = await runCallerCase({
    base: q.base,
    key: q.key.key,
    name: "read",
    sourceHash: "synthetic",
  });
  assert.equal(stopped.stopRound, true);
  assert.equal(stopped.executions, 0);
  assert.equal(q.seen.length, 1);
});
test("receipt is not fabricated and a wrong final response cannot pass the tool loop", async (t) => {
  const c = createCallerCase("write");
  t.after(c.close);
  const fence =
    "```tool_call\n" +
    JSON.stringify({ name: "write", arguments: c.expectedArguments }) +
    "\n```";
  const f = await fixture({
    allowFailover: false,
    turns: [fence, "I did something"],
  });
  t.after(f.close);
  const r = await runCallerCase({
    base: f.base,
    key: f.key.key,
    name: "write",
    sourceHash: "synthetic",
  });
  assert.equal(r.actionVerified, true);
  assert.equal(r.executions, 1);
  assert.equal(r.followedCallerResult, false);
  assert.equal(r.verified, false);
  assert.equal(r.errorCode, "CALLER_RESULT_NOT_FOLLOWED");
});

test("caller acceptance CLI requires explicit opt-in before any provider request", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(
    process.execPath,
    ["scripts/caller-tools-acceptance.mjs", "read"],
    { env: { PATH: process.env.PATH }, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EXPLICIT_LIVE_OPT_IN_REQUIRED/);
  assert.equal(result.stdout, "");
});

for (const [name, api, stream] of [
  ["read", "responses", false],
  ["bash", "chat", true],
  ["search", "responses", true],
]) {
  test(`caller ${name} preserves result linkage through ${api} ${stream ? "SSE" : "JSON"}`, async (t) => {
    const c = createCallerCase(name);
    t.after(c.close);
    const fence =
      "```tool_call\n" +
      JSON.stringify({ name, arguments: c.expectedArguments }) +
      "\n```";
    const f = await fixture({
      allowFailover: false,
      turns: [
        fence,
        (options) =>
          [
            ...options.messages[0].content.matchAll(
              /(?:caller_receipt_|tool_value_)[a-f0-9]{24}/g,
            ),
          ]
            .map((x) => x[0])
            .join(" "),
      ],
    });
    t.after(f.close);
    const report = await runCallerCase({
      base: f.base,
      key: f.key.key,
      name,
      api,
      stream,
      sourceHash: "synthetic",
    });
    assert.equal(report.verified, true);
    assert.equal(report.api, api);
    assert.equal(report.stream, stream);
    assert.equal(report.executions, 1);
    assert.equal(report.followedCallerResult, true);
    assert.deepEqual(report.httpStatuses, [200, 200]);
    assert.deepEqual(report.resolvedModes, stream ? [null, null] : [8, 8]);
    assert.equal(report.nativeModeEvidenceComplete, !stream);
    assert.equal(f.seen.length, 2);
  });
}
test("caller SSE decoder requires a unique completed terminal and ordered Responses lifecycle", async () => {
  const { decodeCallerResponse } =
    await import("../scripts/caller-tools-acceptance.mjs");
  const chunk = JSON.stringify({
    model: "gemini-argon",
    choices: [{ delta: { content: "Synthetic" }, finish_reason: "stop" }],
  });
  assert.throws(
    () => decodeCallerResponse("data: " + chunk + "\n\n", { stream: true }),
    (e) => e.code === "CALLER_SSE_INCOMPLETE",
  );
  assert.equal(
    decodeCallerResponse("data: " + chunk + "\n\ndata: [DONE]\n\n", {
      stream: true,
    }).choices[0].message.content,
    "Synthetic",
  );
  const events = [
    { type: "response.created", sequence_number: 0 },
    {
      type: "response.completed",
      sequence_number: 2,
      response: { model: "gemini-argon", output: [] },
    },
  ];
  assert.throws(
    () =>
      decodeCallerResponse(
        events.map((x) => "data: " + JSON.stringify(x) + "\n\n").join(""),
        { api: "responses", stream: true },
      ),
    (e) => e.code === "CALLER_SSE_SEQUENCE_INVALID",
  );
});

test("acceptance decoder rejects qualified partial completion rather than treating delivery completion as task success", async () => {
  const { decodeCallerResponse } = await import('../scripts/caller-tools-acceptance.mjs');
  const message = { model: 'gemini-argon', choices: [{ delta: {}, finish_reason: 'stop' }] };
  for (const evidence of [{ incomplete: true }, { error: { code: 'NATIVE_STREAM_RESET' } }, { incomplete_details: { reason: 'upstream_interrupted' } }]) {
    const chat = 'data: ' + JSON.stringify({ ...message, ...evidence }) + '\n\ndata: [DONE]\n\n';
    assert.throws(() => decodeCallerResponse(chat, { stream: true }), { code: 'CALLER_RESPONSE_INCOMPLETE' });
    for (const outer of [true, false]) {
      const response = { status: 'completed', model: 'gemini-argon', output: [], ...(outer ? {} : evidence) };
      const event = { type: 'response.completed', sequence_number: 0, response, ...(outer ? evidence : {}) };
      assert.throws(() => decodeCallerResponse('data: ' + JSON.stringify(event) + '\n\n', { api: 'responses', stream: true }), { code: 'CALLER_RESPONSE_INCOMPLETE' });
    }
  }
  assert.throws(() => decodeCallerResponse(JSON.stringify({ ...message, incomplete: true })), { code: 'CALLER_RESPONSE_INCOMPLETE' });
});
