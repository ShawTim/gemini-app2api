// Explicit live opt-in: set GEMINI_GATEWAY_KEY and run with text | chat-tools | responses-tools.
// This CALLER executes one fixed local function. The gateway never executes tools.
import OpenAI from "openai";
const mode = process.argv[2];
if (!["text", "chat-tools", "responses-tools"].includes(mode))
  throw Error(
    "Choose text | chat-tools | responses-tools (these make real model requests)",
  );
if (!process.env.GEMINI_GATEWAY_KEY?.trim())
  throw Error("GEMINI_GATEWAY_KEY required");
const client = new OpenAI({
  baseURL: process.env.GEMINI_GATEWAY_URL || "http://127.0.0.1:18989/v1",
  apiKey: process.env.GEMINI_GATEWAY_KEY.trim(),
  maxRetries: 0,
  timeout: 180000,
});
const model = "gemini-argon";
const fn = {
  name: "local_example_lookup",
  description: "Return a harmless local example record.",
  parameters: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
};
function execute(name, raw) {
  const args = JSON.parse(raw);
  if (
    name !== fn.name ||
    !args ||
    typeof args.key !== "string" ||
    Object.keys(args).length !== 1
  )
    throw Error("Caller rejected tool request");
  return JSON.stringify({ found: true, value: "local-example-value" });
}
if (mode === "text") {
  const r = await client.responses.create({
    model,
    input: "Say hello briefly.",
    thinking_level: 2,
  });
  if (r.status !== "completed")
    throw Error("Incomplete response: " + (r.status ?? "unknown"));
  console.log(r.output_text);
} else if (mode === "chat-tools") {
  const messages = [
    {
      role: "user",
      content:
        "Look up the example record using the declared local tool, then summarize its actual result.",
    },
  ];
  const first = await client.chat.completions.create({
    model,
    messages,
    tools: [{ type: "function", function: fn }],
    tool_choice: "required",
  });
  const choice = first.choices[0];
  if (first.status === "incomplete" || choice?.finish_reason !== "tool_calls")
    throw Error("Incomplete or non-tool Chat turn");
  const message = choice.message;
  if (!message.tool_calls?.length) throw Error("No caller tool request");
  messages.push({
    role: "assistant",
    content: message.content,
    tool_calls: message.tool_calls,
  });
  for (const call of message.tool_calls)
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: execute(call.function.name, call.function.arguments),
    });
  const last = await client.chat.completions.create({
    model,
    messages,
    tools: [{ type: "function", function: fn }],
    tool_choice: "none",
  });
  if (last.status === "incomplete" || last.choices[0]?.finish_reason !== "stop")
    throw Error("Incomplete final Chat turn");
  console.log(last.choices[0].message.content);
} else {
  const input = [
    {
      role: "user",
      content:
        "Look up the example record using the declared local tool, then summarize its actual result.",
    },
  ];
  const first = await client.responses.create({
    model,
    input,
    tools: [{ type: "function", ...fn }],
    tool_choice: "required",
  });
  if (
    first.status !== "completed" ||
    first.output.some((item) => item.status && item.status !== "completed")
  )
    throw Error("Incomplete tool turn: " + (first.status ?? "unknown"));
  const calls = first.output.filter((item) => item.type === "function_call");
  if (!calls.length) throw Error("No caller tool request");
  input.push(...first.output);
  for (const call of calls)
    input.push({
      type: "function_call_output",
      call_id: call.call_id,
      output: execute(call.name, call.arguments),
    });
  const last = await client.responses.create({
    model,
    input,
    tools: [{ type: "function", ...fn }],
    tool_choice: "none",
  });
  if (last.status !== "completed")
    throw Error("Incomplete final response: " + (last.status ?? "unknown"));
  console.log(last.output_text);
}
