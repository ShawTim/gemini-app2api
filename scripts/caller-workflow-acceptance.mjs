// Explicit caller-orchestrated local workflow; gateway never executes these tools.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runtimeHash } from "./live-acceptance.mjs";
import {
  compileToolPolicy,
  parseBoundedJson,
  validateToolCall,
} from "../src/tool-protocol.mjs";
import { decodeCallerResponse } from "./caller-tools-acceptance.mjs";

export const WORKFLOW_STEPS = ["read", "write", "bash", "search"];
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const random = (prefix) => prefix + crypto.randomBytes(12).toString("hex");
const PUBLIC_PREFIX = "workflow-result:";
const FIXED_COMMAND = "cat output.txt";
const CALL_ID = /^call_[A-Za-z0-9_-]{1,200}$/;
const STOP_CODES = [
  "NATIVE_QUOTA_EXHAUSTED",
  "NATIVE_RATE_LIMITED",
  "NATIVE_PRECONDITION_REQUIRED",
  "NATIVE_PERMISSION_OR_AUTH",
  "NATIVE_AUTH_REJECTED",
  "NATIVE_PERMISSION_REJECTED",
  "ACCOUNT_LOGIN_REQUIRED",
  "OAUTH_REFRESH_FAILED",
  "NATIVE_TURN_FAILED",
];
const safeCode = (error) =>
  /^[A-Z0-9_]{1,80}$/.test(error?.code || "")
    ? error.code
    : "CALLER_WORKFLOW_FAILED";
const tool = (name, properties) => ({
  type: "function",
  function: {
    name,
    description: `Request caller-side ${name} in the isolated workflow directory.`,
    parameters: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
  },
});
const schemas = [
  tool("read", { path: { type: "string", enum: ["input.txt"] } }),
  tool("write", {
    path: { type: "string", enum: ["output.txt"] },
    content: { type: "string" },
  }),
  tool("bash", { command: { type: "string", enum: [FIXED_COMMAND] } }),
  tool("search", {
    path: { type: "string", enum: ["output.txt"] },
    query: { type: "string", enum: [PUBLIC_PREFIX] },
  }),
];
const STEP_INSTRUCTIONS = [
  "Now read input.txt and return its actual contents.",
  'Now use the actual read result in this conversation to write output.txt as exactly "workflow-result:" followed by that content. Do not invent or substitute content.',
  "Now run exactly cat output.txt.",
  'Now search output.txt literally for "workflow-result:".',
];
const namedChoice = (api, name) =>
  api === "responses"
    ? { type: "function", name }
    : { type: "function", function: { name } };

function exactArgs(args, expected) {
  const keys = Object.keys(args).sort(),
    expectedKeys = Object.keys(expected).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every(
      (key, i) => key === expectedKeys[i] && args[key] === expected[key],
    )
  );
}
function safeFile(directory, name) {
  const full = path.join(directory, name);
  let stat;
  try {
    stat = fs.lstatSync(full);
  } catch {
    fail("WORKFLOW_FILE_MISSING");
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size > 8192
  )
    fail("UNSAFE_WORKFLOW_FILE");
  return fs.readFileSync(full, "utf8");
}
function sandbox(root) {
  const directory = fs.mkdtempSync(
    path.join(
      root || process.env.PI_SCRATCH_DIR || os.tmpdir(),
      "caller-workflow-",
    ),
  );
  fs.chmodSync(directory, 0o700);
  const hidden = random("hidden_");
  fs.writeFileSync(path.join(directory, "input.txt"), hidden + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  let closed = false;
  return {
    directory,
    hidden,
    close() {
      if (!closed) {
        closed = true;
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
function extract(data, api) {
  if (api === "chat") return data.choices?.[0]?.message;
  const output = data.output || [];
  const calls = output
    .filter((x) => x.type === "function_call")
    .map((x) => ({
      id: x.call_id,
      type: "function",
      function: { name: x.name, arguments: x.arguments },
    }));
  const text = output
    .filter((x) => x.type === "message")
    .flatMap((x) => x.content || [])
    .filter((x) => x.type === "output_text")
    .map((x) => x.text)
    .join("");
  return { role: "assistant", content: text || null, tool_calls: calls };
}

export async function runCallerWorkflow({
  base,
  key,
  sourceHash,
  api = "chat",
  stream = false,
  fetchImpl = fetch,
  root,
} = {}) {
  // modelRequests counts dispatch attempts; successfulModelResponses counts valid successful responses.
  // callerResultsSubmitted counts result messages included in dispatched model requests.
  const report = {
    at: new Date().toISOString(),
    sourceHash,
    api,
    stream,
    selectedModel: "gemini-argon",
    requestedThinking: 2,
    httpStatuses: [],
    resolvedModes: [],
    resolvedThinking: [],
    modelRequests: 0,
    successfulModelResponses: 0,
    callerExecutions: 0,
    callerResultsSubmitted: 0,
    verified: false,
  };
  let box;
  try {
    const url = new URL(base);
    if (
      url.protocol !== "http:" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      fail("CALLER_TEST_REQUIRES_LOOPBACK");
    if (
      typeof key !== "string" ||
      !key ||
      !["chat", "responses"].includes(api) ||
      typeof stream !== "boolean"
    )
      fail("INVALID_CALLER_API_MODE");
    const health = await fetchImpl(url.origin + "/health", {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (!health.ok || (await health.json()).liveValidation !== true)
      fail("LIVE_FAILOVER_MUST_BE_DISABLED");
    box = sandbox(root);
    const session = "workflow_" + crypto.randomBytes(12).toString("hex");
    const history = [
      {
        role: "user",
        content: `Perform this workflow in order: read input.txt; use the actual returned content to write output.txt as exactly "${PUBLIC_PREFIX}" followed by that content; run exactly ${FIXED_COMMAND}; search output.txt literally for "${PUBLIC_PREFIX}". Then answer with the hidden value and every receipt exactly. Never invent results.`,
      },
      { role: "user", content: STEP_INSTRUCTIONS[0] },
    ];
    const usedCallIds = new Set();
    let pendingResults = 0;
    const request = async (choice) => {
      const body = {
        model: "gemini-argon",
        thinking_level: 2,
        stream,
        tools:
          api === "responses"
            ? schemas.map((t) => ({ type: "function", ...t.function }))
            : schemas,
        tool_choice: choice,
        [api === "responses" ? "input" : "messages"]: history,
      };
      report.modelRequests++;
      report.callerResultsSubmitted += pendingResults;
      pendingResults = 0;
      const response = await fetchImpl(
        url.origin +
          (api === "responses" ? "/v1/responses" : "/v1/chat/completions"),
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + key,
            "Content-Type": "application/json",
            "X-Session-ID": session,
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(190000),
        },
      );
      report.httpStatuses.push(response.status);
      const mode = response.headers.get("x-native-mode"),
        thinking = response.headers.get("x-thinking-level");
      report.resolvedModes.push(mode === null ? null : Number(mode));
      report.resolvedThinking.push(thinking === null ? null : Number(thinking));
      let bytes = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) fail("CALLER_TEST_RESPONSE_LIMIT");
        chunks.push(Buffer.from(chunk));
      }
      let data;
      try {
        data = decodeCallerResponse(Buffer.concat(chunks).toString("utf8"), {
          api,
          stream: response.ok && stream,
        });
      } catch (error) {
        if (error.code) throw error;
        fail("CALLER_TEST_INVALID_RESPONSE");
      }
      if (!response.ok)
        fail(
          /^[A-Z0-9_]{1,80}$/.test(data.error?.code || "")
            ? data.error.code
            : "CALLER_TEST_HTTP_FAILURE",
        );
      if ((!stream && (mode !== "8" || thinking !== "2")) || (mode !== null && mode !== "8") || (thinking !== null && thinking !== "2") || data.model !== "gemini-argon")
        fail("CALLER_TEST_MODEL_MISMATCH");
      report.successfulModelResponses++;
      return { data, assistant: extract(data, api) };
    };
    const receipts = [];
    for (let step = 0; step < 4; step++) {
      const name = WORKFLOW_STEPS[step];
      const { data, assistant } = await request(namedChoice(api, name));
      const calls = assistant?.tool_calls || [];
      if (calls.length !== 1) fail("WORKFLOW_EXPECTED_SINGLE_TOOL");
      const call = calls[0];
      if (
        call.type !== "function" ||
        typeof call.id !== "string" ||
        !CALL_ID.test(call.id) ||
        usedCallIds.has(call.id) ||
        call.function?.name !== name
      )
        fail("WORKFLOW_UNEXPECTED_STEP");
      usedCallIds.add(call.id);
      const policy = compileToolPolicy([schemas[step]], "required");
      const args = parseBoundedJson(call.function.arguments, { status: 502 });
      validateToolCall(name, args, policy);
      let actual;
      if (step === 0) {
        if (!exactArgs(args, { path: "input.txt" }))
          fail("WORKFLOW_UNSAFE_ARGUMENTS");
        actual = safeFile(box.directory, "input.txt");
      }
      if (step === 1) {
        const expected = PUBLIC_PREFIX + safeFile(box.directory, "input.txt");
        if (!exactArgs(args, { path: "output.txt", content: expected }))
          fail("WORKFLOW_UNSAFE_ARGUMENTS");
        fs.writeFileSync(path.join(box.directory, "output.txt"), args.content, {
          flag: "wx",
          mode: 0o600,
        });
        actual = safeFile(box.directory, "output.txt");
        if (actual !== expected) fail("WORKFLOW_ACTION_VERIFICATION_FAILED");
      }
      if (step === 2) {
        if (!exactArgs(args, { command: FIXED_COMMAND }))
          fail("WORKFLOW_UNSAFE_ARGUMENTS");
        safeFile(box.directory, "output.txt");
        actual = execFileSync(
          "/bin/bash",
          ["--noprofile", "--norc", "-c", FIXED_COMMAND],
          {
            cwd: box.directory,
            env: { PATH: "/usr/bin:/bin", HOME: box.directory, LANG: "C" },
            timeout: 3000,
            maxBuffer: 8192,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        if (actual !== PUBLIC_PREFIX + safeFile(box.directory, "input.txt"))
          fail("WORKFLOW_ACTION_VERIFICATION_FAILED");
      }
      if (step === 3) {
        if (!exactArgs(args, { path: "output.txt", query: PUBLIC_PREFIX }))
          fail("WORKFLOW_UNSAFE_ARGUMENTS");
        const content = safeFile(box.directory, "output.txt");
        const matches = content
          .split("\n")
          .map((text, i) => ({ path: "output.txt", line: i + 1, text }))
          .filter((x) => x.text.includes(PUBLIC_PREFIX));
        if (
          matches.length !== 1 ||
          matches[0].line !== 1 ||
          matches[0].text !== PUBLIC_PREFIX + box.hidden
        )
          fail("WORKFLOW_ACTION_VERIFICATION_FAILED");
        actual = matches;
      }
      const receipt = random("receipt_");
      receipts.push(receipt);
      report.callerExecutions++;
      const result = {
        step: name,
        verified: true,
        result:
          step === 0
            ? { content: actual }
            : step === 3
              ? { matches: actual }
              : step === 2
                ? { stdout: actual, exitCode: 0 }
                : { written: true, bytes: Buffer.byteLength(actual) },
        receipt,
      };
      if (api === "chat")
        history.push(assistant, {
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      else
        history.push(...(data.output || []), {
          type: "function_call_output",
          call_id: call.id,
          output: JSON.stringify(result),
        });
      pendingResults++;
      if (step < 3)
        history.push({ role: "user", content: STEP_INSTRUCTIONS[step + 1] });
    }
    const { assistant } = await request("none");
    if ((assistant?.tool_calls || []).length)
      fail("WORKFLOW_UNEXPECTED_FINAL_TOOL_CALL");
    const final = assistant?.content;
    report.finalAnswerVerified =
      typeof final === "string" &&
      final.includes(box.hidden) &&
      receipts.every((receipt) => final.includes(receipt));
    if (!report.finalAnswerVerified) fail("WORKFLOW_RECEIPTS_NOT_FOLLOWED");
    report.verified = true;
  } catch (error) {
    report.errorCode = safeCode(error);
    report.stopRound = STOP_CODES.includes(report.errorCode);
  } finally {
    box?.close();
  }
  report.nativeModeEvidenceComplete = report.resolvedModes.length > 0 && report.resolvedModes.every(mode => mode === 8);
  return report;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  const code = async () => {
    if (process.env.GATEWAY_LIVE_CONFIRM !== "owned-accounts-only")
      fail("EXPLICIT_LIVE_OPT_IN_REQUIRED");
    if (process.env.GATEWAY_LIVE_ACCOUNT_SLOT !== "A")
      fail("EXPLICIT_ACCOUNT_SLOT_REQUIRED");
    if (
      typeof process.env.GEMINI_GATEWAY_KEY !== "string" ||
      !process.env.GEMINI_GATEWAY_KEY
    )
      fail("GATEWAY_KEY_REQUIRED");
    const api = process.argv[2] || "chat",
      format = process.argv[3] || "json";
    if (
      !["chat", "responses"].includes(api) ||
      !["json", "sse"].includes(format)
    )
      fail("INVALID_CALLER_API_MODE");
    const report = await runCallerWorkflow({
      base: process.env.GATEWAY_LIVE_BASE || "http://127.0.0.1:18989",
      key: process.env.GEMINI_GATEWAY_KEY,
      sourceHash: runtimeHash(),
      api,
      stream: format === "sse",
    });
    console.log(JSON.stringify(report));
    if (!report.verified) process.exitCode = 1;
  };
  code().catch((error) => {
    console.error(safeCode(error));
    process.exitCode = 1;
  });
}
