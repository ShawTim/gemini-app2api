import test from "node:test";
import assert from "node:assert/strict";
import { normalizeChatRequest, buildCanonicalPrompt } from "../src/openai-contract.mjs";
import { compileToolPolicy, createToolCallSplitter } from "../src/tool-protocol.mjs";

test("plain text explicitly requests the next assistant reply without enabling tool calls",()=>{
  const body=normalizeChatRequest({messages:[{role:"user",content:"Synthetic ordinary question"}]});
  const prompt=buildCanonicalPrompt(body).messages[0].content;
  assert.ok(prompt.includes("Answer the latest user request now as the assistant"));
  assert.ok(prompt.includes("Synthetic ordinary question"));
  assert.ok(prompt.includes("Tool calls are prohibited"));
  assert.equal(compileToolPolicy(body.tools,body.tool_choice).enabled,false);
});

test("tool_choice none tells the assistant to use caller results and finish, while executable calls remain forbidden",()=>{
  const tools=[{type:"function",function:{name:"synthetic_lookup",parameters:{type:"object",properties:{key:{type:"string"}},required:["key"],additionalProperties:false}}}];
  const body=normalizeChatRequest({model:"gemini-argon",tools,tool_choice:"none",messages:[
    {role:"user",content:"Use the lookup result when supplied."},
    {role:"assistant",content:null,tool_calls:[{id:"call_synthetic",type:"function",function:{name:"synthetic_lookup",arguments:'{"key":"sample"}'}}]},
    {role:"tool",tool_call_id:"call_synthetic",content:'{"value":"synthetic-caller-result"}'},
  ]});
  const prompt=buildCanonicalPrompt(body).messages[0].content;
  assert.ok(prompt.includes("use them to complete your answer"));
  assert.ok(prompt.includes("do not wait for another user message"));
  assert.ok(prompt.includes("synthetic-caller-result"));assert.ok(prompt.includes("call_synthetic"));
  const splitter=createToolCallSplitter({policy:compileToolPolicy(body.tools,body.tool_choice)});
  assert.throws(()=>{splitter.push('```tool_call\n{"name":"synthetic_lookup","arguments":{"key":"sample"}}\n```\n');splitter.flush();},e=>e.code==="TOOL_CALL_NOT_ALLOWED");
});
