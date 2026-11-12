import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runCallerWorkflow } from "../scripts/caller-workflow-acceptance.mjs";
import { fixture } from "./gateway-fixture.mjs";

const request = (name, args) =>
  "```tool_call\n" + JSON.stringify({ name, arguments: args }) + "\n```";
function stagedTurns(finalMode = "good") {
  return [
    request("read", { path: "input.txt" }),
    (options) => {
      const value = /hidden_[a-f0-9]{24}/.exec(
        options.messages[0].content,
      )?.[0];
      assert.ok(value, "read result is in replay history");
      return request("write", {
        path: "output.txt",
        content: "workflow-result:" + value + "\n",
      });
    },
    request("bash", { command: "cat output.txt" }),
    request("search", { path: "output.txt", query: "workflow-result:" }),
    (options) => {
      const text = options.messages[0].content;
      const receipts = [...text.matchAll(/receipt_[a-f0-9]{24}/g)].map(
        (x) => x[0],
      );
      const value = /hidden_[a-f0-9]{24}/.exec(text)?.[0];
      return finalMode === "missing"
        ? "completed"
        : `${value} ${receipts.join(" ")}`;
    },
  ];
}
function spyFetch(seen) {
  return async (url, options = {}) => {
    if (String(url).endsWith("/health")) return fetch(url, options);
    seen.push({ headers: options.headers, body: JSON.parse(options.body) });
    return fetch(url, options);
  };
}
function inputHistory(requestRecord, api) {
  return api === "responses"
    ? requestRecord.body.input
    : requestRecord.body.messages;
}
function callIds(history, api) {
  return api === "responses"
    ? history.filter((x) => x.type === "function_call").map((x) => x.call_id)
    : history
        .filter((x) => x.role === "assistant")
        .flatMap((x) => (x.tool_calls || []).map((c) => c.id));
}

test("full five-request replay, stable session, real effects and receipts", async (t) => {
  const f = await fixture({ allowFailover: false, turns: stagedTurns() });
  t.after(f.close);
  const requests = [];
  const report = await runCallerWorkflow({
    base: f.base,
    key: f.key.key,
    sourceHash: "offline-synthetic",
    fetchImpl: spyFetch(requests),
  });
  assert.equal(report.verified, true, JSON.stringify(report));
  assert.equal(report.modelRequests, 5);
  assert.equal(report.successfulModelResponses, 5);
  assert.equal(report.callerExecutions, 4);
  assert.equal(report.callerResultsSubmitted, 4);
  assert.deepEqual(report.httpStatuses, [200, 200, 200, 200, 200]);
  assert.deepEqual(report.resolvedModes, [8, 8, 8, 8, 8]);
  assert.deepEqual(report.resolvedThinking, [2, 2, 2, 2, 2]);
  assert.equal(requests.length, 5);
  assert.equal(new Set(requests.map((x) => x.headers["X-Session-ID"])).size, 1);
  assert.doesNotMatch(
    JSON.stringify(inputHistory(requests[0], "chat")),
    /hidden_[a-f0-9]{24}/,
  );
  const names = ["read", "write", "bash", "search"];
  let previous = [];
  for (let i = 0; i < requests.length; i++) {
    const history = inputHistory(requests[i], "chat");
    assert.deepEqual(history.slice(0, previous.length), previous);
    assert.deepEqual(
      requests[i].body.tool_choice,
      i < 4
        ? { type: "function", function: { name: names[i] } }
        : "none",
    );
    if (i < 4)
      assert.match(history.at(-1).content, /^Now /);
    if (i === 1) {
      assert.match(history.at(-1).content, /actual read result/);
      assert.match(JSON.stringify(history), /hidden_[a-f0-9]{24}/);
    }
    assert.ok(history[0].content.includes("read input.txt"));
    assert.equal(callIds(history, "chat").length, i);
    assert.equal(history.filter((x) => x.role === "tool").length, i);
    previous = history;
  }
  assert.doesNotMatch(
    JSON.stringify(report),
    /hidden_|receipt_|Bearer|synthetic-refresh|\/Users\//,
  );
});

for (const [api, stream] of [
  ["chat", true],
  ["responses", false],
  ["responses", true],
]) {
  test(`complete linked replay: ${api} ${stream ? "SSE" : "JSON"}`, async (t) => {
    const f = await fixture({ allowFailover: false, turns: stagedTurns() });
    t.after(f.close);
    const requests = [];
    const report = await runCallerWorkflow({
      base: f.base,
      key: f.key.key,
      sourceHash: "synthetic",
      api,
      stream,
      fetchImpl: spyFetch(requests),
    });
    assert.equal(report.verified, true, JSON.stringify(report));
    assert.equal(report.modelRequests, 5);
    assert.equal(report.callerExecutions, 4);
    assert.deepEqual(report.httpStatuses, [200, 200, 200, 200, 200]);
    assert.equal(
      new Set(requests.map((x) => x.headers["X-Session-ID"])).size,
      1,
    );
    let previous = [];
    for (let i = 0; i < 5; i++) {
      const history = inputHistory(requests[i], api);
      assert.deepEqual(history.slice(0, previous.length), previous);
      const names = ["read", "write", "bash", "search"];
      assert.deepEqual(
        requests[i].body.tool_choice,
        i === 4
          ? "none"
          : api === "responses"
            ? { type: "function", name: names[i] }
            : { type: "function", function: { name: names[i] } },
      );
      if (i < 4) assert.match(history.at(-1).content, /^Now /);
      const ids = callIds(history, api);
      assert.equal(ids.length, i);
      const resultIds =
        api === "responses"
          ? history
              .filter((x) => x.type === "function_call_output")
              .map((x) => x.call_id)
          : history.filter((x) => x.role === "tool").map((x) => x.tool_call_id);
      assert.deepEqual(ids, resultIds);
      previous = history;
    }
  });
}

test("key ordering is irrelevant; wrong write and arbitrary shell stop immediately", async (t) => {
  const f = await fixture({
    allowFailover: false,
    turns: [
      request("read", { path: "input.txt" }),
      (options) => {
        const value = /hidden_[a-f0-9]{24}/.exec(
          options.messages[0].content,
        )?.[0];
        return request("write", {
          content: "workflow-result:" + value + "\n",
          path: "output.txt",
        });
      },
      request("bash", { command: "cat output.txt" }),
      request("search", { query: "workflow-result:", path: "output.txt" }),
      (options) => {
        const text = options.messages[0].content;
        return `${/hidden_[a-f0-9]{24}/.exec(text)?.[0]} ${[...text.matchAll(/receipt_[a-f0-9]{24}/g)].map((x) => x[0]).join(" ")}`;
      },
    ],
  });
  t.after(f.close);
  const good = await runCallerWorkflow({
    base: f.base,
    key: f.key.key,
    sourceHash: "synthetic",
  });
  assert.equal(good.verified, true, JSON.stringify(good));
  for (const [badArgs, requestCount, executionCount] of [
    [{ path: "output.txt", content: "wrong" }, 2, 1],
    [{ command: "touch injected" }, 3, 2],
  ]) {
    const bad = await fixture({
      allowFailover: false,
      turns: [
        request("read", { path: "input.txt" }),
        (options) =>
          request("write", {
            path: "output.txt",
            content:
              badArgs.content ??
              "workflow-result:" +
                /hidden_[a-f0-9]{24}/.exec(options.messages[0].content)?.[0] +
                "\n",
          }),
        request("bash", badArgs),
      ],
    });
    t.after(bad.close);
    const r = await runCallerWorkflow({
      base: bad.base,
      key: bad.key.key,
      sourceHash: "synthetic",
    });
    assert.equal(r.verified, false);
    assert.equal(r.callerExecutions, executionCount);
    assert.equal(r.modelRequests, requestCount);
    assert.equal(r.callerResultsSubmitted, requestCount - 1);
  }
});

test("missing receipts, reset, quota, precondition and wrong thinking have bounded metrics", async (t) => {
  const f = await fixture({
    allowFailover: false,
    turns: stagedTurns("missing"),
  });
  t.after(f.close);
  let r = await runCallerWorkflow({
    base: f.base,
    key: f.key.key,
    sourceHash: "synthetic",
  });
  assert.equal(r.errorCode, "WORKFLOW_RECEIPTS_NOT_FOLLOWED");
  assert.equal(r.callerExecutions, 4);
  for (const [code, stop] of [
    ["NATIVE_STREAM_RESET", false],
    ["NATIVE_QUOTA_EXHAUSTED", true],
    ["NATIVE_PRECONDITION_REQUIRED", true],
  ]) {
    const g = await fixture({
      allowFailover: false,
      turns: [
        Object.assign(Error("private"), {
          code,
          status: code.includes("QUOTA") ? 429 : 502,
        }),
      ],
    });
    t.after(g.close);
    r = await runCallerWorkflow({
      base: g.base,
      key: g.key.key,
      sourceHash: "synthetic",
    });
    assert.equal(r.modelRequests, 1);
    assert.equal(r.successfulModelResponses, 0);
    assert.equal(r.callerResultsSubmitted, 0);
    assert.equal(r.callerExecutions, 0);
    assert.equal(r.stopRound, stop, `${code}: ${JSON.stringify(r)}`);
  }
  const wrong = await fixture({
    allowFailover: false,
    turns: [{ text: request("read", { path: "input.txt" }), thinking: 1 }],
  });
  t.after(wrong.close);
  r = await runCallerWorkflow({
    base: wrong.base,
    key: wrong.key.key,
    sourceHash: "synthetic",
  });
  assert.equal(r.errorCode, "CALLER_TEST_MODEL_MISMATCH");
  assert.equal(r.modelRequests, 1);
  assert.equal(r.callerExecutions, 0);
});

test("Responses duplicate IDs are rejected across history after real first execution", async (t) => {
  const f = await fixture({
    allowFailover: false,
    turns: [
      request("read", { path: "input.txt" }),
      request("write", { path: "output.txt", content: "wrong" }),
    ],
  });
  t.after(f.close);
  let count = 0,
    firstCallId;
  const mutate = async (url, options = {}) => {
    if (String(url).endsWith("/health")) return fetch(url, options);
    const response = await fetch(url, options);
    count++;
    if (count === 1)
      firstCallId = (await response.clone().json()).output.find(
        (x) => x.type === "function_call",
      ).call_id;
    if (count === 2) {
      const body = await response.json();
      body.output.find((x) => x.type === "function_call").call_id = firstCallId;
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: response.headers,
      });
    }
    return response;
  };
  const r = await runCallerWorkflow({
    base: f.base,
    key: f.key.key,
    sourceHash: "synthetic",
    api: "responses",
    fetchImpl: mutate,
  });
  assert.equal(r.errorCode, "WORKFLOW_UNEXPECTED_STEP");
  assert.equal(r.modelRequests, 2);
  assert.equal(r.callerExecutions, 1);
  assert.equal(r.callerResultsSubmitted, 1);
});

test("malformed call type and final extra call are rejected", async (t) => {
  const f = await fixture({ allowFailover: false, turns: stagedTurns() });
  t.after(f.close);
  let count = 0;
  const typeMutation = async (url, options = {}) => {
    if (String(url).endsWith("/health")) return fetch(url, options);
    const response = await fetch(url, options);
    count++;
    if (count === 1) {
      const body = await response.json();
      body.choices[0].message.tool_calls[0].type = "bad";
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: response.headers,
      });
    }
    return response;
  };
  let r = await runCallerWorkflow({
    base: f.base,
    key: f.key.key,
    sourceHash: "synthetic",
    fetchImpl: typeMutation,
  });
  assert.equal(r.errorCode, "WORKFLOW_UNEXPECTED_STEP");
  assert.equal(r.callerExecutions, 0);
  assert.equal(r.modelRequests, 1);

  const g = await fixture({ allowFailover: false, turns: stagedTurns() });
  t.after(g.close);
  count = 0;
  const finalCall = async (url, options = {}) => {
    if (String(url).endsWith("/health")) return fetch(url, options);
    const response = await fetch(url, options);
    count++;
    if (count === 5) {
      const body = await response.json();
      body.choices[0].message.tool_calls = [
        {
          id: "call_extra",
          type: "function",
          function: { name: "read", arguments: "{}" },
        },
      ];
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: response.headers,
      });
    }
    return response;
  };
  r = await runCallerWorkflow({
    base: g.base,
    key: g.key.key,
    sourceHash: "synthetic",
    fetchImpl: finalCall,
  });
  assert.equal(r.errorCode, "WORKFLOW_UNEXPECTED_FINAL_TOOL_CALL");
  assert.equal(r.verified, false);
  assert.equal(r.callerExecutions, 4);
});

test("health gate, symlink refusal and sandbox cleanup on failure", async (t) => {
  let calls = 0;
  const health = await fixture({ allowFailover: false });
  t.after(health.close);
  const disabled = await runCallerWorkflow({
    base: health.base,
    key: health.key.key,
    sourceHash: "synthetic",
    fetchImpl: async (url, options) => {
      calls++;
      return String(url).endsWith("/health")
        ? new Response(JSON.stringify({ liveValidation: false }), {
            status: 200,
          })
        : fetch(url, options);
    },
  });
  assert.equal(disabled.errorCode, "LIVE_FAILOVER_MUST_BE_DISABLED");
  assert.equal(calls, 1);
  assert.equal(disabled.modelRequests, 0);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await fixture({
    allowFailover: false,
    turns: [request("read", { path: "input.txt" })],
  });
  t.after(f.close);
  let attacked = false;
  const inject = async (url, options = {}) => {
    if (String(url).endsWith("/health")) return fetch(url, options);
    if (!attacked) {
      attacked = true;
      const dir = path.join(root, fs.readdirSync(root)[0]);
      fs.unlinkSync(path.join(dir, "input.txt"));
      fs.symlinkSync(path.join(dir, "other.txt"), path.join(dir, "input.txt"));
    }
    return fetch(url, options);
  };
  const unsafe = await runCallerWorkflow({
    base: f.base,
    key: f.key.key,
    sourceHash: "synthetic",
    root,
    fetchImpl: inject,
  });
  assert.equal(unsafe.errorCode, "UNSAFE_WORKFLOW_FILE");
  assert.equal(unsafe.callerExecutions, 0);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("write refuses overwrite and cleans sandbox after execution error", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workflow-overwrite-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = await fixture({
    allowFailover: false,
    turns: [
      request("read", { path: "input.txt" }),
      (options) => {
        const value = /hidden_[a-f0-9]{24}/.exec(
          options.messages[0].content,
        )?.[0];
        return request("write", {
          path: "output.txt",
          content: "workflow-result:" + value + "\n",
        });
      },
    ],
  });
  t.after(f.close);
  let injected = false;
  const fetchImpl = async (url, options = {}) => {
    if (String(url).endsWith("/health")) return fetch(url, options);
    const response = await fetch(url, options),
      body = JSON.parse(options.body);
    if (!injected && body.messages.some((m) => m.role === "tool")) {
      injected = true;
      const dir = path.join(root, fs.readdirSync(root)[0]);
      fs.writeFileSync(path.join(dir, "output.txt"), "preserve-existing", {
        flag: "wx",
      });
    }
    return response;
  };
  const r = await runCallerWorkflow({
    base: f.base,
    key: f.key.key,
    sourceHash: "synthetic",
    root,
    fetchImpl,
  });
  assert.equal(r.modelRequests, 2);
  assert.equal(r.callerExecutions, 1);
  assert.equal(r.callerResultsSubmitted, 1);
  assert.equal(r.verified, false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("CLI consent and unknown formats are rejected before network access", async () => {
  const { spawnSync } = await import("node:child_process");
  let result = spawnSync(
    process.execPath,
    ["scripts/caller-workflow-acceptance.mjs"],
    { env: { PATH: process.env.PATH }, encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EXPLICIT_LIVE_OPT_IN_REQUIRED/);
  assert.equal(result.stdout, "");
  result = spawnSync(
    process.execPath,
    ["scripts/caller-workflow-acceptance.mjs", "unknown", "json"],
    {
      env: {
        PATH: process.env.PATH,
        GATEWAY_LIVE_CONFIRM: "owned-accounts-only",
        GATEWAY_LIVE_ACCOUNT_SLOT: "A",
        GEMINI_GATEWAY_KEY: "synthetic",
      },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /INVALID_CALLER_API_MODE/);
  assert.equal(result.stdout, "");
});
