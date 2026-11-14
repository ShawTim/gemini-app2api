#!/usr/bin/env node
// Explicit live opt-in only. Never part of npm test / PR CI. No retries or account switching.
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { sourceFiles, sourceDigest } from "./release-files.mjs";
export function runtimeHash() {
  const files = sourceFiles().filter(
    (n) =>
      n.startsWith("src/") ||
      n === "bin/gemini-gateway" ||
      (n.startsWith("native-wire/") && !n.includes("/test/")),
  );
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(sourceDigest(files)))
    .digest("hex");
}
export async function liveCase({
  base,
  key,
  caseName,
  accountSlot,
  thinkingLevel = 2,
  sourceHash = runtimeHash(),
}) {
  const u = new URL(base);
  if (
    u.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    u.username ||
    u.password
  )
    throw Error("LIVE_REQUIRES_ISOLATED_LOOPBACK_GATEWAY");
  if (!["A", "B"].includes(accountSlot)) throw Error("ACCOUNT_SLOT_REQUIRED");
  if (
    !Number.isInteger(thinkingLevel) ||
    thinkingLevel < 0 ||
    thinkingLevel > 4
  )
    throw Error("INVALID_LIVE_THINKING_LEVEL");
  if (
    ![
      "text",
      "chat-tools-json",
      "chat-tools-sse",
      "responses-tools-json",
      "responses-tools-sse",
    ].includes(caseName)
  )
    throw Error("UNKNOWN_LIVE_CASE");
  const report = {
    version: "1.2.0",
    sourceHash,
    at: new Date().toISOString(),
    platform: process.platform + "-" + process.arch,
    accountSlot,
    case: caseName,
    selectedModel: "gemini-argon",
    requestedThinking: thinkingLevel,
    resolvedModes: [],
    resolvedThinking: [],
    httpStatuses: [],
    calls: 0,
    callerResults: 0,
    followedCallerResult: false,
    verified: false,
  };
  const session = "live_" + crypto.randomBytes(12).toString("hex");
  const sse = caseName.endsWith("-sse"),
    responses = caseName.startsWith("responses-");
  async function request(path, body) {
    const r = await fetch(u.origin + path, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + key,
        "Content-Type": "application/json",
        "X-Session-ID": session,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(190000),
      redirect: "error",
    });
    report.httpStatuses.push(r.status);
    const mode = r.headers.get("x-native-mode"),
      thinking = r.headers.get("x-thinking-level");
    report.resolvedModes.push(mode === null ? null : Number(mode));
    report.resolvedThinking.push(
      thinking === null || thinking === "" ? null : Number(thinking),
    );
    let bytes = 0,
      chunks = [];
    for await (const b of r.body) {
      bytes += b.length;
      if (bytes > 4 * 1024 * 1024)
        throw Object.assign(Error(), { code: "LIVE_RESPONSE_LIMIT" });
      chunks.push(b);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!r.ok) {
      let code;
      try {
        code = JSON.parse(text).error?.code;
      } catch {}
      throw Object.assign(Error(), {
        code: /^[A-Z0-9_]+$/.test(code || "") ? code : "LIVE_HTTP_ERROR",
      });
    }
    if ((!sse && mode !== "8") || (mode !== null && mode !== "8"))
      throw Object.assign(Error(), { code: "LIVE_MODE_EVIDENCE_MISMATCH" });
    if (!sse) {
      const data = JSON.parse(text);
      if (data.incomplete || data.incomplete_details) throw Object.assign(Error(), { code: "LIVE_RESPONSE_INCOMPLETE" });
      return data;
    }
    const data = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));
    if (responses) {
      const events = data
        .filter((x) => x !== "[DONE]")
        .map((x) => JSON.parse(x));
      const completed = events.filter((x) => x.type === "response.completed");
      if (completed.length !== 1 || events.at(-1)?.type !== "response.completed")
        throw Object.assign(Error(), { code: "LIVE_SSE_INCOMPLETE" });
      if (events.some((event, index) => !Number.isSafeInteger(event.sequence_number) || (index && event.sequence_number !== events[index - 1].sequence_number + 1)))
        throw Object.assign(Error(), { code: "LIVE_SSE_SEQUENCE_INVALID" });
      if (events.some(event => event.incomplete || event.error || event.incomplete_details || event.response?.incomplete || event.response?.error || event.response?.incomplete_details) || completed[0].response?.status !== "completed")
        throw Object.assign(Error(), { code: "LIVE_RESPONSE_INCOMPLETE" });
      return completed[0].response;
    }
    if (data.at(-1) !== "[DONE]" || data.filter(row => row === "[DONE]").length !== 1)
      throw Object.assign(Error(), { code: "LIVE_SSE_INCOMPLETE" });
    const content = [],
      calls = new Map();
    let finished = 0;
    for (const entry of data.slice(0, -1).map((x) => JSON.parse(x))) {
      if (entry.incomplete || entry.error || entry.incomplete_details)
        throw Object.assign(Error(), { code: "LIVE_RESPONSE_INCOMPLETE" });
      if (entry.model !== "gemini-argon")
        throw Object.assign(Error(), { code: "LIVE_MODEL_LABEL_MISMATCH" });
      for (const choice of entry.choices) {
        if (choice.finish_reason) finished++;
        if (choice.delta.content) content.push(choice.delta.content);
        for (const part of choice.delta.tool_calls || []) {
          const call = calls.get(part.index) || {
            id: "",
            type: "function",
            function: { name: "", arguments: "" },
          };
          call.id ||= part.id || "";
          call.function.name += part.function?.name || "";
          call.function.arguments += part.function?.arguments || "";
          calls.set(part.index, call);
        }
      }
    }
    if (finished !== 1)
      throw Object.assign(Error(), { code: "LIVE_SSE_INCOMPLETE" });
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
  const fn = {
    name: "acceptance_lookup",
    description:
      "Look up the caller-owned acceptance value. Never guess the result.",
    parameters: {
      type: "object",
      properties: { key: { type: "string", enum: ["acceptance"] } },
      required: ["key"],
      additionalProperties: false,
    },
  };
  try {
    const health = await fetch(u.origin + "/health", {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    if (!health.ok || (await health.json()).liveValidation !== true)
      throw Object.assign(Error(), { code: "LIVE_FAILOVER_MUST_BE_DISABLED" });
    if (caseName === "text") {
      const r = await request("/v1/chat/completions", {
        model: "gemini-argon",
        messages: [{ role: "user", content: "Reply with a brief greeting." }],
        thinking_level: thinkingLevel,
      });
      if (
        r.model !== "gemini-argon" ||
        !r.choices?.[0]?.message?.content?.trim()
      )
        throw Object.assign(Error(), { code: "LIVE_TEXT_INVALID" });
      report.verified = true;
    } else {
      const messages = [
        {
          role: "user",
          content:
            "Call acceptance_lookup once with key acceptance. After I return its value, repeat that exact value in your final answer. Do not guess it.",
        },
      ];
      const tools = responses
        ? [{ type: "function", ...fn }]
        : [{ type: "function", function: fn }];
      const path = responses ? "/v1/responses" : "/v1/chat/completions";
      const first = await request(path, {
        model: "gemini-argon",
        [responses ? "input" : "messages"]: messages,
        tools,
        tool_choice: "required",
        thinking_level: thinkingLevel,
        stream: sse,
      });
      if (first.model !== "gemini-argon")
        throw Object.assign(Error(), { code: "LIVE_MODEL_LABEL_MISMATCH" });
      const calls = responses
        ? first.output
            .filter((x) => x.type === "function_call")
            .map((x) => ({
              id: x.call_id,
              name: x.name,
              arguments: x.arguments,
            }))
        : (first.choices[0].message.tool_calls || []).map((x) => ({
            id: x.id,
            name: x.function.name,
            arguments: x.function.arguments,
          }));
      report.calls = calls.length;
      if (calls.length !== 1 || calls[0].name !== fn.name || !calls[0].id)
        throw Object.assign(Error(), { code: "LIVE_TOOL_REQUEST_INVALID" });
      const args = JSON.parse(calls[0].arguments);
      if (!args || args.key !== "acceptance" || Object.keys(args).length !== 1)
        throw Object.assign(Error(), { code: "LIVE_TOOL_ARGUMENT_INVALID" });
      // The caller executes only this fixed local lookup, after receiving a validated request.
      const value = crypto.randomBytes(16).toString("hex"),
        result = JSON.stringify({ value });
      report.callerResults = 1;
      const history = responses
        ? [
            ...messages,
            ...first.output,
            {
              type: "function_call_output",
              call_id: calls[0].id,
              output: result,
            },
          ]
        : [
            ...messages,
            first.choices[0].message,
            { role: "tool", tool_call_id: calls[0].id, content: result },
          ];
      const last = await request(path, {
        model: "gemini-argon",
        [responses ? "input" : "messages"]: history,
        tools,
        tool_choice: "none",
        thinking_level: thinkingLevel,
        stream: sse,
      });
      const content = responses
        ? last.output
            .filter((x) => x.type === "message")
            .flatMap((x) => x.content)
            .filter((x) => x.type === "output_text")
            .map((x) => x.text)
            .join("")
        : last.choices[0].message.content;
      report.followedCallerResult =
        typeof content === "string" && content.includes(value);
      if (!report.followedCallerResult || last.model !== "gemini-argon")
        throw Object.assign(Error(), {
          code: "LIVE_CALLER_RESULT_NOT_CONFIRMED",
        });
      report.verified = true;
    }
  } catch (error) {
    report.errorCode = /^[A-Z0-9_]+$/.test(error?.code || "")
      ? error.code
      : "LIVE_CASE_FAILED";
    report.stopRound = true; // No next case or account is automatically invoked.
  }
  report.nativeModeEvidenceComplete = report.resolvedModes.length > 0 && report.resolvedModes.every(mode => mode === 8);
  return report;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.env.GATEWAY_LIVE_CONFIRM !== "owned-accounts-only")
    throw Error("EXPLICIT_LIVE_OPT_IN_REQUIRED");
  if (!process.env.GEMINI_GATEWAY_KEY) throw Error("GATEWAY_KEY_REQUIRED");
  const report = await liveCase({
    base: process.env.GATEWAY_LIVE_BASE || "http://127.0.0.1:18989",
    key: process.env.GEMINI_GATEWAY_KEY,
    caseName: process.argv[2],
    thinkingLevel:
      process.env.GATEWAY_LIVE_THINKING_LEVEL === undefined
        ? 2
        : Number(process.env.GATEWAY_LIVE_THINKING_LEVEL),
    accountSlot: process.env.GATEWAY_LIVE_ACCOUNT_SLOT,
  });
  console.log(JSON.stringify(report));
  if (!report.verified) process.exitCode = 1;
}
