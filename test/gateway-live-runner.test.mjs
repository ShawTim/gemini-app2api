// The opt-in live runner is itself tested with synthetic local gateway only.
import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./gateway-fixture.mjs";
import { liveCase } from "../scripts/live-acceptance.mjs";
const call =
  '```tool_call\n{"name":"acceptance_lookup","arguments":{"key":"acceptance"}}\n```';
for (const caseName of [
  "text",
  "chat-tools-json",
  "chat-tools-sse",
  "responses-tools-json",
  "responses-tools-sse",
])
  test(
    "live runner synthetic correctness and safe report: " + caseName,
    async (t) => {
      const f = await fixture({
        allowFailover: false,
        turns:
          caseName === "text"
            ? ["Synthetic greeting"]
            : [
                call,
                (options) =>
                  options.messages[0].content.match(/[a-f0-9]{32}/g).at(-1),
              ],
      });
      t.after(f.close);
      const report = await liveCase({
        base: f.base,
        key: f.key.key,
        caseName,
        accountSlot: "A",
        sourceHash: "synthetic-source-only",
      });
      assert.equal(report.verified, true);
      assert.deepEqual(
        report.resolvedModes,
        caseName === "text" ? [8] : caseName.endsWith('-sse') ? [null, null] : [8, 8],
      );
      assert.equal(report.nativeModeEvidenceComplete, !caseName.endsWith('-sse'));
      assert.equal(report.calls, caseName === "text" ? 0 : 1);
      assert.equal(report.callerResults, report.calls);
      assert.doesNotMatch(
        JSON.stringify(report),
        /Synthetic greeting|acceptance_lookup|tool_call_id|Bearer|synthetic-refresh|sk-gw-/,
      );
    },
  );
test("live runner refuses failover-enabled runtime before inference and stops on quota", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const input = {
    base: f.base,
    key: f.key.key,
    caseName: "text",
    accountSlot: "B",
    sourceHash: "synthetic-only",
  };
  assert.equal(
    (await liveCase(input)).errorCode,
    "LIVE_FAILOVER_MUST_BE_DISABLED",
  );
  assert.equal(f.seen.length, 0);
  const stop = await fixture({
    allowFailover: false,
    turns: [
      Object.assign(Error("private"), {
        code: "NATIVE_QUOTA_EXHAUSTED",
        status: 429,
      }),
    ],
  });
  t.after(stop.close);
  const result = await liveCase({
    ...input,
    base: stop.base,
    key: stop.key.key,
  });
  assert.equal(result.verified, false);
  assert.equal(result.stopRound, true);
  assert.equal(result.errorCode, "NATIVE_QUOTA_EXHAUSTED");
  assert.equal(stop.seen.length, 1);
  assert.equal(stop.app.pool.failovers.length, 0);
});

test("live runner records explicit thinking without substituting models or silently changing requested levels", async (t) => {
  const f = await fixture({
    allowFailover: false,
    turns: [
      call,
      (options) => options.messages[0].content.match(/[a-f0-9]{32}/g).at(-1),
    ],
  });
  t.after(f.close);
  const report = await liveCase({
    base: f.base,
    key: f.key.key,
    caseName: "chat-tools-json",
    accountSlot: "A",
    sourceHash: "synthetic-only",
    thinkingLevel: 1,
  });
  assert.equal(report.verified, true);
  assert.equal(report.requestedThinking, 1);
  assert.deepEqual(report.resolvedThinking, [1, 1]);
  assert.deepEqual(report.resolvedModes, [8, 8]);
  assert.ok(f.seen.every((x) => x.thinkingLevel === 1 && x.modeCategory === 8));
  const before = f.seen.length;
  await assert.rejects(
    liveCase({
      base: f.base,
      key: f.key.key,
      caseName: "text",
      accountSlot: "A",
      thinkingLevel: 9,
    }),
    /INVALID_LIVE_THINKING_LEVEL/,
  );
  assert.equal(f.seen.length, before);
});
