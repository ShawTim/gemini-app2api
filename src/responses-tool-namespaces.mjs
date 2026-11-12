// Responses namespace adapter. The prompt protocol remains flat and caller-owned.
// Codex 0.148.0 ResponseItem uses function_call { namespace?, name, ... }.
// Internal aliases never appear on the Responses wire. Symbols cannot be supplied
// by JSON clients and survive canonical-body/result object spreads, not JSON output.
import { plainObject, protocolError } from './tool-protocol.mjs';
export const RESPONSE_TOOL_IDENTITIES = Symbol('responseToolIdentities');
const fail = code => { throw protocolError(code, 400); };
const keys = (value, allowed) => {
  if (!plainObject(value)) fail('INVALID_TOOL_DECLARATION');
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('UNSUPPORTED_PARAMETER');
};
const name = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) fail('INVALID_TOOL_DECLARATION');
  return value;
};

export function normalizeResponsesTools(payload) {
  const source = payload.tools === undefined ? [] : payload.tools;
  if (!Array.isArray(source)) fail('INVALID_TOOL_DECLARATION');
  if (source.length > 64 || Buffer.byteLength(JSON.stringify(source)) > 256 * 1024) fail('TOOL_SIZE_LIMIT');
  const declarations = [], namespaces = new Set(), reserved = new Set(), identities = new Map(), aliases = new Map();
  const add = (tool, namespace, description) => {
    keys(tool, ['type', 'name', 'description', 'parameters', 'strict']);
    if (tool.type !== 'function') fail('UNSUPPORTED_TOOL_TYPE');
    name(tool.name);
    if (tool.description !== undefined && typeof tool.description !== 'string') fail('INVALID_TOOL_DECLARATION');
    if (declarations.length >= 64) fail('TOOL_SIZE_LIMIT');
    declarations.push({ tool, namespace, description });
    if (namespace === undefined) reserved.add(tool.name);
  };
  for (const tool of source) {
    if (plainObject(tool) && tool.type === 'namespace') {
      keys(tool, ['type', 'name', 'description', 'tools']);
      name(tool.name);
      if (namespaces.has(tool.name) || typeof tool.description !== 'string' || !Array.isArray(tool.tools) || !tool.tools.length) fail('INVALID_TOOL_DECLARATION');
      namespaces.add(tool.name);
      for (const child of tool.tools) add(child, tool.name, tool.description);
    } else add(tool);
  }
  // Reserve historical flat names too: an undeclared old call must not alias a
  // currently declared namespace tool. History is not current authorization.
  for (const item of Array.isArray(payload.input) ? payload.input : []) {
    if (item?.type === 'function_call' && item.namespace == null && typeof item.name === 'string') reserved.add(item.name);
  }
  let nextAlias = 0;
  const callName = (toolName, namespace) => {
    name(toolName);
    if (namespace == null) return toolName;
    name(namespace);
    const key = JSON.stringify([namespace, toolName]);
    if (!aliases.has(key)) {
      let alias;
      do { alias = `ns_${nextAlias++}`; } while (reserved.has(alias));
      reserved.add(alias); aliases.set(key, alias);
      identities.set(alias, { namespace, name: toolName });
    }
    return aliases.get(key);
  };
  const tools = declarations.map(({ tool, namespace, description }) => {
    const { type, ...fn } = tool;
    const mapped = { ...fn, name: callName(fn.name, namespace) };
    if (namespace !== undefined) mapped.description = `Namespace tool ${JSON.stringify({ namespace, name: fn.name })}. ${description}\n${fn.description ?? ''}`;
    return { type, function: mapped };
  });
  let choice = payload.tool_choice ?? 'auto';
  if (payload.tool_choice === null) fail('UNSUPPORTED_TOOL_CHOICE');
  if (plainObject(choice)) {
    // Only the established flat forced-choice shape is supported. No invented
    // namespace selector: string auto/none/required apply to all flattened tools.
    keys(choice, ['type', 'name']);
    if (choice.type !== 'function') fail('UNSUPPORTED_TOOL_CHOICE');
    choice = { type: 'function', function: { name: choice.name } };
    // A flat selector must not accidentally select a generated alias.
    if (identities.has(choice.function.name)) fail('UNDECLARED_TOOL');
  }
  return { tools, choice, callName, identities };
}

export function responsesCallFields(call, metadata) {
  const identity = metadata?.[RESPONSE_TOOL_IDENTITIES]?.get(call.function.name);
  return { call_id: call.id, ...(identity ?? { name: call.function.name }), arguments: call.function.arguments };
}
