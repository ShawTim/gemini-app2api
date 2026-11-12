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
api_key = os.environ.get("GEMINI_GATEWAY_KEY", "").strip()
if not api_key:
    raise SystemExit("GEMINI_GATEWAY_KEY required")
client = OpenAI(base_url=os.environ.get("GEMINI_GATEWAY_URL", "http://127.0.0.1:18989/v1"),
                api_key=api_key, max_retries=0, timeout=180)
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
    r = client.responses.create(model=model, input="Say hello briefly.",
                                extra_body={"thinking_level": 2})
    if r.status != "completed":
        raise RuntimeError(f"Incomplete response: {r.status}")
    print(r.output_text)
elif mode == "chat-tools":
    messages = [{"role": "user", "content": "Look up the example record with the declared local tool, then summarize its actual result."}]
    tools = [{"type": "function", "function": fn}]
    first = client.chat.completions.create(model=model, messages=messages, tools=tools, tool_choice="required")
    choice = first.choices[0]
    if getattr(first, "status", None) == "incomplete" or choice.finish_reason != "tool_calls":
        raise RuntimeError("Incomplete or non-tool Chat turn")
    message = choice.message
    if not message.tool_calls:
        raise ValueError("No caller tool request")
    messages.append({"role": "assistant", "content": message.content,
                     "tool_calls": [c.model_dump(exclude_none=True) for c in message.tool_calls]})
    for call in message.tool_calls:
        messages.append({"role": "tool", "tool_call_id": call.id,
                         "content": execute(call.function.name, call.function.arguments)})
    last = client.chat.completions.create(model=model, messages=messages, tools=tools, tool_choice="none")
    if getattr(last, "status", None) == "incomplete" or last.choices[0].finish_reason != "stop":
        raise RuntimeError("Incomplete final Chat turn")
    print(last.choices[0].message.content)
else:
    items = [{"role": "user", "content": "Look up the example record with the declared local tool, then summarize its actual result."}]
    tools = [{"type": "function", **fn}]
    first = client.responses.create(model=model, input=items, tools=tools, tool_choice="required")
    if first.status != "completed" or any(getattr(c, "status", None) not in (None, "completed") for c in first.output):
        raise RuntimeError(f"Incomplete tool turn: {first.status}")
    calls = [c for c in first.output if c.type == "function_call"]
    if not calls:
        raise ValueError("No caller tool request")
    items.extend(c.model_dump(exclude_none=True) for c in first.output)
    for call in calls:
        items.append({"type": "function_call_output", "call_id": call.call_id,
                      "output": execute(call.name, call.arguments)})
    last = client.responses.create(model=model, input=items, tools=tools, tool_choice="none")
    if last.status != "completed":
        raise RuntimeError(f"Incomplete final response: {last.status}")
    print(last.output_text)
