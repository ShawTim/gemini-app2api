// Explicit caller-side acceptance only. The gateway never executes these tools.
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

export const CALLER_CASES = ["read", "write", "bash", "search"];
export const FIXED_BASH_COMMAND = "printf 'shell-ok\\n'; cat bash-input.txt";
const fail = (code) => {
  throw Object.assign(Error(code), { code });
};
const marker = (prefix) => prefix + crypto.randomBytes(12).toString("hex");

export function createCallerCase(
  name,
  { root = process.env.PI_SCRATCH_DIR || fs.realpathSync(os.tmpdir()) } = {},
) {
  if (!CALLER_CASES.includes(name)) fail("UNKNOWN_CALLER_TOOL");
  const directory = fs.mkdtempSync(
    path.join(root, "gateway-caller-" + name + "-"),
  );
  fs.chmodSync(directory, 0o700);
  const value = marker("tool_value_");
  const writtenText = "Synthetic caller write test.\n";
  const expected =
    name === "read"
      ? { path: "read-input.txt" }
      : name === "write"
        ? { path: "write-output.txt", content: writtenText }
        : name === "bash"
          ? { command: FIXED_BASH_COMMAND }
          : { path: ".", query: "needle" };
  if (name === "read")
    fs.writeFileSync(path.join(directory, expected.path), value + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  if (name === "bash")
    fs.writeFileSync(path.join(directory, "bash-input.txt"), value + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  if (name === "search")
    fs.writeFileSync(
      path.join(directory, "search-input.txt"),
      "unmatched\nneedle " + value + "\n",
      { flag: "wx", mode: 0o600 },
    );
  const descriptions = {
    read: "Read a UTF-8 file in the isolated test directory.",
    write: "Create a UTF-8 file in the isolated test directory.",
    bash: "Execute the supplied allowlisted shell command in the isolated test directory.",
    search:
      "Search files in the isolated test directory for a literal text query.",
  };
  const tool = {
    type: "function",
    function: {
      name,
      description: descriptions[name],
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(expected).map(([key, allowed]) => [
            key,
            { type: "string", enum: [allowed] },
          ]),
        ),
        required: Object.keys(expected),
        additionalProperties: false,
      },
    },
  };
  const prompt =
    name === "read"
      ? "Use read to read read-input.txt. After receiving its result, quote the file content and the exact receipt."
      : name === "write"
        ? `Use write to create write-output.txt with this exact content: ${JSON.stringify(writtenText)}. After receiving its result, quote the exact receipt.`
        : name === "bash"
          ? `Use bash to execute this command exactly: ${JSON.stringify(FIXED_BASH_COMMAND)}. After receiving its result, quote stdout and the exact receipt.`
          : "Use search to find the literal text needle under path '.'. After receiving its result, quote the matching line and the exact receipt.";
  const policy = compileToolPolicy([tool], "required");
  let used = false;
  const read = (file) => {
    const target = path.join(directory, file);
    const stat = fs.lstatSync(target);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 8192
    )
      fail("UNSAFE_CALLER_FIXTURE");
    return fs.readFileSync(target, "utf8");
  };
  return {
    directory,
    name,
    tool,
    prompt,
    expectedArguments: { ...expected },
    execute(call) {
      if (used) fail("CALLER_TOOL_ALREADY_EXECUTED");
      if (
        !call ||
        call.type !== "function" ||
        typeof call.id !== "string" ||
        !/^call_[A-Za-z0-9_-]{1,200}$/.test(call.id)
      )
        fail("INVALID_CALLER_TOOL_CALL");
      const args = parseBoundedJson(call.function?.arguments, { status: 502 });
      validateToolCall(call.function?.name, args, policy);
      if (
        JSON.stringify(Object.keys(args).sort()) !==
          JSON.stringify(Object.keys(expected).sort()) ||
        Object.keys(expected).some((key) => args[key] !== expected[key])
      )
        fail("UNSAFE_CALLER_TOOL_ARGUMENTS");
      used = true;
      let result,
        actionVerified = false;
      if (name === "read") {
        const content = read(expected.path);
        result = { content };
        actionVerified = content === value + "\n";
      } else if (name === "write") {
        fs.writeFileSync(path.join(directory, expected.path), args.content, {
          flag: "wx",
          mode: 0o600,
        });
        const content = read(expected.path);
        result = { written: true, bytes: Buffer.byteLength(content) };
        actionVerified = content === writtenText;
      } else if (name === "bash") {
        read("bash-input.txt");
        const stdout = execFileSync(
          "/bin/bash",
          ["--noprofile", "--norc", "-c", FIXED_BASH_COMMAND],
          {
            cwd: directory,
            env: { PATH: "/usr/bin:/bin", HOME: directory, LANG: "C" },
            timeout: 3000,
            maxBuffer: 8192,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        result = { stdout, exitCode: 0 };
        actionVerified = stdout === "shell-ok\n" + value + "\n";
      } else {
        const content = read("search-input.txt");
        const matches = content
          .split("\n")
          .map((line, i) => ({
            path: "search-input.txt",
            line: i + 1,
            text: line,
          }))
          .filter((match) => match.text.includes(args.query));
        result = { matches };
        actionVerified =
          matches.length === 1 && matches[0].text === "needle " + value;
      }
      if (!actionVerified) fail("CALLER_ACTION_VERIFICATION_FAILED");
      const receipt = marker("caller_receipt_");
      result.receipt = receipt;
      return {
        result,
        actionVerified,
        verifyReply: (text) =>
          typeof text === "string" &&
          text.includes(receipt) &&
          (name === "write" || text.includes(value)),
      };
    },
    close() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function decodeCallerResponse(
  text,
  { api = "chat", stream = false } = {},
) {
  if (!stream) {
    const data = JSON.parse(text);
    if (data.incomplete || data.incomplete_details) fail("CALLER_RESPONSE_INCOMPLETE");
    return data;
  }
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim());
  if (!rows.length) fail("CALLER_SSE_INCOMPLETE");
  if (api === "responses") {
    const events = rows.map((row) => JSON.parse(row));
    const completed = events.filter(
      (event) => event.type === "response.completed",
    );
    if (completed.length !== 1 || events.at(-1).type !== "response.completed")
      fail("CALLER_SSE_INCOMPLETE");
    for (let i = 0; i < events.length; i++)
      if (
        !Number.isSafeInteger(events[i].sequence_number) ||
        (i && events[i].sequence_number !== events[i - 1].sequence_number + 1)
      )
        fail("CALLER_SSE_SEQUENCE_INVALID");
    if (events.some(event => event.incomplete || event.error || event.incomplete_details || event.response?.incomplete || event.response?.error || event.response?.incomplete_details) || completed[0].response?.status !== "completed")
      fail("CALLER_RESPONSE_INCOMPLETE");
    return completed[0].response;
  }
  if (
    rows.at(-1) !== "[DONE]" ||
    rows.filter((row) => row === "[DONE]").length !== 1
  )
    fail("CALLER_SSE_INCOMPLETE");
  const calls = new Map(),
    content = [];
  let finishes = 0;
  for (const row of rows.slice(0, -1)) {
    const event = JSON.parse(row);
    if (event.incomplete || event.error || event.incomplete_details) fail("CALLER_RESPONSE_INCOMPLETE");
    if (event.model !== "gemini-argon") fail("CALLER_TEST_MODEL_MISMATCH");
    for (const choice of event.choices || []) {
      if (choice.finish_reason) finishes++;
      if (choice.delta?.content) content.push(choice.delta.content);
      for (const delta of choice.delta?.tool_calls || []) {
        if (
          !Number.isSafeInteger(delta.index) ||
          delta.index < 0 ||
          delta.index >= 32
        )
          fail("CALLER_SSE_CALL_INDEX_INVALID");
        const call = calls.get(delta.index) || {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        };
        if (delta.id && call.id && delta.id !== call.id)
          fail("CALLER_SSE_CALL_ID_MISMATCH");
        call.id ||= delta.id || "";
        call.function.name += delta.function?.name || "";
        call.function.arguments += delta.function?.arguments || "";
        calls.set(delta.index, call);
      }
    }
  }
  if (finishes !== 1) fail("CALLER_SSE_INCOMPLETE");
  return {
    model: "gemini-argon",
    choices: [
      {
        message: {
          role: "assistant",
          content: content.join("") || null,
          ...(calls.size ? { tool_calls: [...calls.values()] } : {}),
        },
      },
    ],
  };
}

export async function runCallerCase({
  base,
  key,
  name,
  sourceHash,
  thinkingLevel = 2,
  api = "chat",
  stream = false,
  root,
  fetchImpl = fetch,
  keepSandbox = false,
}) {
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
    !Number.isInteger(thinkingLevel) ||
    thinkingLevel < 0 ||
    thinkingLevel > 4
  )
    fail("INVALID_CALLER_TEST_THINKING");
  if (!CALLER_CASES.includes(name)) fail("UNKNOWN_CALLER_TOOL");
  if (!["chat", "responses"].includes(api) || typeof stream !== "boolean")
    fail("INVALID_CALLER_API_MODE");
  const report = {
    at: new Date().toISOString(),
    sourceHash,
    platform: process.platform + "-" + process.arch,
    accountSlot: "A",
    tool: name,
    api,
    stream,
    searchKind: name === "search" ? "local-literal-text" : null,
    selectedModel: "gemini-argon",
    requestedThinking: thinkingLevel,
    httpStatuses: [],
    resolvedModes: [],
    resolvedThinking: [],
    calls: 0,
    executions: 0,
    callerResultsSubmitted: 0,
    argumentsValidated: false,
    actionVerified: false,
    followedCallerResult: false,
    verified: false,
  };
  let sandbox;
  const session = "caller_" + crypto.randomBytes(12).toString("hex");
  const request = async (body) => {
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
    let length = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 4 * 1024 * 1024) fail("CALLER_TEST_RESPONSE_LIMIT");
      chunks.push(Buffer.from(chunk));
    }
    const responseText = Buffer.concat(chunks).toString("utf8");
    let data;
    try {
      data = decodeCallerResponse(responseText, {
        api,
        stream: response.ok && stream,
      });
    } catch (error) {
      if (error?.code) throw error;
      fail("CALLER_TEST_INVALID_RESPONSE");
    }
    if (!response.ok)
      fail(
        /^[A-Z0-9_]{1,80}$/.test(data.error?.code ?? "")
          ? data.error.code
          : "CALLER_TEST_HTTP_FAILURE",
      );
    if ((!stream && mode !== "8") || (mode !== null && mode !== "8") || data.model !== "gemini-argon")
      fail("CALLER_TEST_MODEL_MISMATCH");
    return data;
  };
  try {
    const health = await fetchImpl(url.origin + "/health", {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    if (!health.ok || (await health.json()).liveValidation !== true)
      fail("LIVE_FAILOVER_MUST_BE_DISABLED");
    sandbox = createCallerCase(name, { root });
    const messages = [{ role: "user", content: sandbox.prompt }];
    const common = {
      model: "gemini-argon",
      thinking_level: thinkingLevel,
      stream,
      tools:
        api === "responses"
          ? [{ type: "function", ...sandbox.tool.function }]
          : [sandbox.tool],
    };
    const first = await request({
      ...common,
      [api === "responses" ? "input" : "messages"]: messages,
      tool_choice: "required",
    });
    const assistant = first.choices?.[0]?.message;
    const calls =
      api === "responses"
        ? (first.output || [])
            .filter((item) => item.type === "function_call")
            .map((item) => ({
              id: item.call_id,
              type: "function",
              function: { name: item.name, arguments: item.arguments },
            }))
        : (assistant?.tool_calls ?? []);
    report.calls = calls.length;
    if (calls.length !== 1 || calls[0].function?.name !== name)
      fail("CALLER_TEST_EXPECTED_SINGLE_TOOL");
    const execution = sandbox.execute(calls[0]);
    report.argumentsValidated = true;
    report.executions = 1;
    report.actionVerified = execution.actionVerified;
    const content = JSON.stringify(execution.result);
    report.callerResultsSubmitted = 1;
    const last = await request({
      ...common,
      [api === "responses" ? "input" : "messages"]:
        api === "responses"
          ? [
              ...messages,
              ...first.output,
              {
                type: "function_call_output",
                call_id: calls[0].id,
                output: content,
              },
            ]
          : [
              ...messages,
              assistant,
              { role: "tool", tool_call_id: calls[0].id, content },
            ],
      tool_choice: "none",
    });
    report.followedCallerResult = execution.verifyReply(
      api === "responses"
        ? (last.output || [])
            .filter((item) => item.type === "message")
            .flatMap((item) => item.content || [])
            .filter((item) => item.type === "output_text")
            .map((item) => item.text)
            .join("")
        : last.choices?.[0]?.message?.content,
    );
    if (!report.followedCallerResult) fail("CALLER_RESULT_NOT_FOLLOWED");
    report.verified = true;
  } catch (error) {
    report.errorCode = /^[A-Z0-9_]{1,80}$/.test(error?.code ?? "")
      ? error.code
      : "CALLER_TEST_FAILED";
    report.stopRound = [
      "NATIVE_QUOTA_EXHAUSTED",
      "NATIVE_RATE_LIMITED",
      "NATIVE_PERMISSION_OR_AUTH",
      "NATIVE_AUTH_REJECTED",
      "NATIVE_PERMISSION_REJECTED",
      "ACCOUNT_LOGIN_REQUIRED",
      "OAUTH_REFRESH_FAILED",
    ].includes(report.errorCode);
  } finally {
    if (!keepSandbox) sandbox?.close();
  }
  report.nativeModeEvidenceComplete = report.resolvedModes.length > 0 && report.resolvedModes.every(mode => mode === 8);
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.env.GATEWAY_LIVE_CONFIRM !== "owned-accounts-only")
    fail("EXPLICIT_LIVE_OPT_IN_REQUIRED");
  if (!process.env.GEMINI_GATEWAY_KEY) fail("GATEWAY_KEY_REQUIRED");
  if (process.env.GATEWAY_LIVE_ACCOUNT_SLOT !== "A")
    fail("EXPLICIT_ACCOUNT_A_REQUIRED");
  const format = process.argv[4] ?? "json";
  if (!["json", "sse"].includes(format)) fail("INVALID_CALLER_API_MODE");
  const report = await runCallerCase({
    base: process.env.GATEWAY_LIVE_BASE || "http://127.0.0.1:18989",
    key: process.env.GEMINI_GATEWAY_KEY,
    name: process.argv[2],
    api: process.argv[3] ?? "chat",
    stream: format === "sse",
    sourceHash: runtimeHash(),
    thinkingLevel:
      process.env.GATEWAY_LIVE_THINKING_LEVEL === undefined
        ? 2
        : Number(process.env.GATEWAY_LIVE_THINKING_LEVEL),
  });
  console.log(JSON.stringify(report));
  if (!report.verified) process.exitCode = 1;
}
