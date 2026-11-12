import test from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import {
  fixture,
  tools,
  responseTools,
  toolBlock,
} from "./gateway-fixture.mjs";

test("official JavaScript SDK: models, Chat JSON/SSE tools and caller result continuation", async (t) => {
  const f = await fixture({
    turns: [
      toolBlock,
      "Synthetic final",
      toolBlock,
      "Synthetic streamed final",
    ],
  });
  t.after(f.close);
  const client = new OpenAI({
    apiKey: f.key.key,
    baseURL: f.base + "/v1",
    maxRetries: 0,
  });
  assert.equal((await client.models.list()).data[0].id, "gemini-argon");
  const messages = [{ role: "user", content: "Synthetic request" }];
  const first = await client.chat.completions.create({
    model: "gemini-argon",
    messages,
    tools,
  });
  assert.equal(first.choices[0].finish_reason, "tool_calls");
  const second = await client.chat.completions.create({
    model: "gemini-argon",
    tools,
    messages: [
      ...messages,
      first.choices[0].message,
      {
        role: "tool",
        tool_call_id: first.choices[0].message.tool_calls[0].id,
        content: "Synthetic caller output",
      },
    ],
  });
  assert.equal(second.choices[0].message.content, "Synthetic final");
  const stream = await client.chat.completions.create({
    model: "gemini-argon",
    messages,
    tools,
    stream: true,
  });
  let calls = 0,
    finish;
  for await (const chunk of stream) {
    calls += chunk.choices[0]?.delta?.tool_calls?.length ?? 0;
    finish = chunk.choices[0]?.finish_reason ?? finish;
  }
  assert.equal(calls, 1);
  assert.equal(finish, "tool_calls");
  const text = await client.chat.completions.create({
    model: "gemini-argon",
    messages,
    stream: true,
  });
  let output = "";
  for await (const chunk of text)
    output += chunk.choices[0]?.delta?.content ?? "";
  assert.equal(output, "Synthetic streamed final");
});
test("official JavaScript SDK: Responses JSON and event stream with tools/results", async (t) => {
  const f = await fixture({
    turns: [
      toolBlock,
      "Synthetic response final",
      toolBlock,
      "Synthetic response stream",
    ],
  });
  t.after(f.close);
  const client = new OpenAI({
    apiKey: f.key.key,
    baseURL: f.base + "/v1",
    maxRetries: 0,
  });
  const first = await client.responses.create({
    model: "gemini-argon",
    input: "Synthetic request",
    tools: responseTools,
  });
  const call = first.output.find((v) => v.type === "function_call");
  assert.ok(call);
  assert.equal(call.name, "fixture_lookup");
  const second = await client.responses.create({
    model: "gemini-argon",
    tools: responseTools,
    input: [
      { role: "user", content: "Synthetic request" },
      ...first.output,
      {
        type: "function_call_output",
        call_id: call.call_id,
        output: "Synthetic caller output",
      },
    ],
  });
  assert.equal(second.output_text, "Synthetic response final");
  const stream = await client.responses.create({
    model: "gemini-argon",
    input: "Synthetic request",
    tools: responseTools,
    stream: true,
  });
  const types = [];
  let finished;
  for await (const event of stream) {
    types.push(event.type);
    if (event.type === "response.completed") finished = event.response;
  }
  assert.ok(types.includes("response.function_call_arguments.done"));
  assert.ok(types.includes("response.completed"));
  assert.equal(
    finished.output.find((v) => v.type === "function_call").name,
    "fixture_lookup",
  );
  const textStream = await client.responses.create({
    model: "gemini-argon",
    input: "Synthetic request",
    stream: true,
  });
  let text = "";
  for await (const event of textStream)
    if (event.type === "response.output_text.delta") text += event.delta;
  assert.equal(text, "Synthetic response stream");
});
