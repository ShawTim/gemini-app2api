"""Official SDK against a synthetic local gateway. No Google credentials/network."""
import os
from openai import OpenAI
from importlib.metadata import version
assert version('openai') == '2.48.0', 'Use the pinned SDK test environment'
client = OpenAI(api_key=os.environ['FIXTURE_KEY'], base_url=os.environ['FIXTURE_BASE'] + '/v1', max_retries=0)
tool = {'type': 'function', 'function': {'name': 'fixture_lookup', 'parameters': {'type': 'object', 'properties': {'key': {'type': 'string'}}, 'required': ['key'], 'additionalProperties': False}}}
messages = [{'role': 'user', 'content': 'Synthetic request'}]
assert client.models.list().data[0].id == 'gemini-argon'
first = client.chat.completions.create(model='gemini-argon', messages=messages, tools=[tool])
call = first.choices[0].message.tool_calls[0]
assert call.function.name == 'fixture_lookup'
second = client.chat.completions.create(model='gemini-argon', tools=[tool], messages=messages + [first.choices[0].message.model_dump(exclude_none=True), {'role': 'tool', 'tool_call_id': call.id, 'content': 'Synthetic caller output'}])
assert second.choices[0].message.content == 'Synthetic final'
stream = client.chat.completions.create(model='gemini-argon', messages=messages, tools=[tool], stream=True)
assert any(chunk.choices and chunk.choices[0].delta.tool_calls for chunk in stream)
response_tool = {'type': 'function', **tool['function']}
r = client.responses.create(model='gemini-argon', input='Synthetic request', tools=[response_tool])
rcall = next(item for item in r.output if item.type == 'function_call')
rr = client.responses.create(model='gemini-argon', tools=[response_tool], input=[{'role': 'user', 'content': 'Synthetic request'}] + [item.model_dump(exclude_none=True) for item in r.output] + [{'type': 'function_call_output', 'call_id': rcall.call_id, 'output': 'Synthetic caller output'}])
assert rr.output_text == 'Synthetic response final'
stream = client.responses.create(model='gemini-argon', input='Synthetic request', tools=[response_tool], stream=True)
types = [event.type for event in stream]
assert 'response.function_call_arguments.done' in types
assert 'response.completed' in types
print('python_sdk_models_chat_json_sse_responses_json_sse_and_tool_results=passed')
