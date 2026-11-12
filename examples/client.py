"""Explicit live opt-in: python client.py text | chat-tools | responses-tools.
The caller executes a fixed allowlisted local function; never model-supplied code.
"""
import json
import os
import sys
from openai import OpenAI

mode = sys.argv[1] if len(sys.argv) > 1 else ""
if mode not in ("text", "chat-tools", "responses-tools"):
    raise SystemExit("Choose text | chat-tools | responses-tools (real model requests)")
client = OpenAI(base_url=os.environ.get("GEMINI_GATEWAY_URL", "http://127.0.0.1:18989/v1"),
                api_key=os.environ["GEMINI_GATEWAY_KEY"], max_retries=0, timeout=180)
model = "gemini-argon"
fn = {"name": "local_example_lookup", "description": "Return a harmless local example record.",
      "parameters": {"type": "object", "properties": {"key": {"type": "string"}},
                     "required": ["key"], "additionalProperties": False}}


def execute(name, raw):
    args = json.loads(raw)
    if name != fn["name"] or not isinstance(args, dict) or set(args) != {"key"} or not isinstance(args["key"], str):
        raise ValueError("Caller rejected tool request")
    return json.dumps({"found": True, "value": "local-example-value"})


if mode == "text":
    print(client.responses.create(model=model, input="Say hello briefly.",
                                  extra_body={"thinking_level": 2}).output_text)
elif mode == "chat-tools":
    messages = [{"role": "user", "content": "Look up the example record with the declared local tool, then summarize its actual result."}]
    tools = [{"type": "function", "function": fn}]
    first = client.chat.completions.create(model=model, messages=messages, tools=tools, tool_choice="required")
    message = first.choices[0].message
    if not message.tool_calls:
        raise ValueError("No caller tool request")
    messages.append({"role": "assistant", "content": message.content,
                     "tool_calls": [c.model_dump(exclude_none=True) for c in message.tool_calls]})
    for call in message.tool_calls:
        messages.append({"role": "tool", "tool_call_id": call.id,
                         "content": execute(call.function.name, call.function.arguments)})
    print(client.chat.completions.create(model=model, messages=messages, tools=tools, tool_choice="none").choices[0].message.content)
else:
    items = [{"role": "user", "content": "Look up the example record with the declared local tool, then summarize its actual result."}]
    tools = [{"type": "function", **fn}]
    first = client.responses.create(model=model, input=items, tools=tools, tool_choice="required")
    calls = [c for c in first.output if c.type == "function_call"]
    if not calls:
        raise ValueError("No caller tool request")
    items.extend(c.model_dump(exclude_none=True) for c in first.output)
    for call in calls:
        items.append({"type": "function_call_output", "call_id": call.call_id,
                      "output": execute(call.name, call.arguments)})
    print(client.responses.create(model=model, input=items, tools=tools, tool_choice="none").output_text)
