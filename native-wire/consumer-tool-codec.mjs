/** Caller-owned native tool wire codec. Pure protobuf/JSON conversion;
 * zero executor, authentication, network or desktop-app I/O.
 */
import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';
import { parse, lengthDelimited as m, varintField as v, varint as unsignedVarint, MAX_MESSAGE_BYTES } from './protobuf.mjs';
import { buildClientGenerate, buildRequestMetadata, NATIVE_VERSION } from './robin-current.mjs';
export const TOOL_LIMITS = Object.freeze({ tools: 64, calls: 32, depth: 16, nodes: 4096, bytes: 256 * 1024, frameBytes: 1024 * 1024 });
// Native ClientCapability wire 379, distinct from in-memory enum 394 or metadata CapabilityType.
const CLIENT_TOOLS_CAPABILITY = 379;
// The proven Mac client locks BOTH the Argon mode and the deep-thinking level on
// every request. Sending mode alone was a fidelity gap, not a deliberate choice.
const ARGON_MODE_CATEGORY = 8;
const ARGON_THINKING_LEVEL = 2;
export class ConsumerToolError extends Error {
  constructor(code, status = 400) { super('Native consumer tool bridge request failed'); this.name = 'ConsumerToolError'; this.code = code; this.status = status; }
}
export const rejectTool = (code, status = 400) => { throw new ConsumerToolError(code, status); };
const utf8 = new TextDecoder('utf-8', { fatal: true });
const cat = (...parts) => Buffer.concat(parts);
const s = (n, value) => m(n, Buffer.from(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function string(value, max = TOOL_LIMITS.bytes, empty = true) {
  if (typeof value !== 'string' || (!empty && !value.length) || Buffer.byteLength(value) > max || utf8.decode(Buffer.from(value)) !== value) rejectTool('INVALID_TOOL_STRING');
  return value;
}
function keys(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) rejectTool('UNSUPPORTED_TOOL_SCHEMA'); }
function tick(budget, depth) { if (++budget.nodes > TOOL_LIMITS.nodes || depth > TOOL_LIMITS.depth) rejectTool('TOOL_SIZE_LIMIT'); }
const SCHEMA_ANNOTATIONS = ['\u0024schema', '\u0024id', 'title', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'format'];
function schemaKeys(value, allowed) { keys(value, [...allowed, ...SCHEMA_ANNOTATIONS]); }
const types = Object.freeze({ string: 1, number: 2, integer: 3, boolean: 4, array: 5, object: 6, null: 7 });
// TypeBox/PI represents string options as anyOf string const branches.
// Only this exact enum-equivalent form is supported, not arbitrary unions.
function literalSchema(schema) {
  if (!object(schema)) return schema;
  if (Object.hasOwn(schema, 'anyOf')) {
    schemaKeys(schema, ['anyOf', 'description', 'nullable', 'type']);
    if ((schema.type !== undefined && schema.type !== 'string') || !Array.isArray(schema.anyOf) || !schema.anyOf.length || schema.anyOf.length > 128) rejectTool('UNSUPPORTED_TOOL_SCHEMA');
    const values = schema.anyOf.map(branch => {
      schemaKeys(branch, ['type', 'const']);
      if (branch.type !== 'string' || typeof branch.const !== 'string') rejectTool('UNSUPPORTED_TOOL_SCHEMA');
      return branch.const;
    });
    if (new Set(values).size !== values.length) rejectTool('UNSUPPORTED_TOOL_SCHEMA');
    const { anyOf, ...rest } = schema;
    return { ...rest, type: 'string', enum: values };
  }
  if (Object.hasOwn(schema, 'const')) {
    schemaKeys(schema, ['type', 'const', 'description', 'nullable']);
    if (schema.type !== 'string' || typeof schema.const !== 'string') rejectTool('UNSUPPORTED_TOOL_SCHEMA');
    const { const: value, ...rest } = schema;
    return { ...rest, enum: [value] };
  }
  return schema;
}
function schemaWire(schema, budget, depth = 0) {
  tick(budget, depth);
  schema = literalSchema(schema);
  schemaKeys(schema, ['type', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'additionalProperties', 'minimum', 'maximum']);
  if (typeof schema.type !== 'string' || !Object.hasOwn(types, schema.type)) rejectTool('UNSUPPORTED_TOOL_SCHEMA');
  // Numeric bounds are retained in the prompt/registry and enforced locally;
  // no unproven native schema wire fields are invented for these constraints.
  for (const key of ['minimum', 'maximum']) if (schema[key] !== undefined && (!['number', 'integer'].includes(schema.type) || typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) rejectTool('UNSUPPORTED_TOOL_SCHEMA');
  if (schema.minimum !== undefined && schema.maximum !== undefined && schema.minimum > schema.maximum) rejectTool('UNSUPPORTED_TOOL_SCHEMA');
  const out = [v(1, types[schema.type])];
  if (schema.description !== undefined) out.push(s(3, string(schema.description)));
  if (schema.nullable !== undefined) { if (typeof schema.nullable !== 'boolean') rejectTool('UNSUPPORTED_TOOL_SCHEMA'); out.push(v(4, Number(schema.nullable))); }
  if (schema.enum !== undefined) {
    if (schema.type !== 'string' || !Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 128 || new Set(schema.enum).size !== schema.enum.length) rejectTool('UNSUPPORTED_TOOL_SCHEMA');
    for (const item of schema.enum) out.push(s(5, string(item)));
  }
  if (schema.type === 'array') { if (!schema.items) rejectTool('UNSUPPORTED_TOOL_SCHEMA'); out.push(m(6, schemaWire(schema.items, budget, depth + 1))); }
  else if (schema.items !== undefined) rejectTool('UNSUPPORTED_TOOL_SCHEMA');
  if (schema.type === 'object') {
    const props = schema.properties === undefined ? {} : schema.properties;
    if (!object(props)) rejectTool('UNSUPPORTED_TOOL_SCHEMA');
    for (const [name, child] of Object.entries(props)) out.push(m(7, cat(s(1, string(name, 256, false)), m(2, schemaWire(child, budget, depth + 1)))));
    if (schema.required !== undefined) {
      if (!Array.isArray(schema.required) || new Set(schema.required).size !== schema.required.length) rejectTool('UNSUPPORTED_TOOL_SCHEMA');
      for (const name of schema.required) { if (typeof name !== 'string' || !Object.hasOwn(props, name)) rejectTool('UNSUPPORTED_TOOL_SCHEMA'); out.push(s(8, name)); }
    }
    // No guessed wire flag: this restriction is checked locally on every call.
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) rejectTool('UNSUPPORTED_TOOL_SCHEMA');
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) rejectTool('UNSUPPORTED_TOOL_SCHEMA');
  return Buffer.concat(out);
}
/** Current-image Beyond_Schema encoder shared by the legacy Mac facade. */
export function encodeConsumerToolSchema(schema) {
  const bytes = schemaWire(schema, { nodes: 0 });
  if (bytes.length > TOOL_LIMITS.bytes) rejectTool('TOOL_SIZE_LIMIT');
  return bytes;
}
export function compileConsumerTools(tools = [], toolChoice = 'auto') {
  if (!['auto', 'none'].includes(toolChoice)) rejectTool('UNSUPPORTED_TOOL_CHOICE');
  if (!Array.isArray(tools) || tools.length > TOOL_LIMITS.tools) rejectTool('TOOL_SIZE_LIMIT');
  const registry = new Map(), budget = { nodes: 0 }; let size = 0;
  for (const tool of tools) {
    keys(tool, ['type', 'function']); if (tool.type !== 'function') rejectTool('UNSUPPORTED_TOOL_TYPE');
    const fn = tool.function; keys(fn, ['name', 'description', 'parameters', 'strict']);
    if (typeof fn.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(fn.name) || registry.has(fn.name)) rejectTool('INVALID_TOOL_DECLARATION');
    if (fn.strict !== undefined && fn.strict !== false) rejectTool('UNSUPPORTED_TOOL_SCHEMA');
    const parameters = fn.parameters === undefined ? { type: 'object', properties: {} } : fn.parameters;
    if (!object(parameters) || parameters.type !== 'object') rejectTool('UNSUPPORTED_TOOL_SCHEMA');
    const parameterBytes = schemaWire(parameters, budget);
    const declaration = cat(s(1, fn.name), ...(fn.description === undefined ? [] : [s(2, string(fn.description))]), m(3, parameterBytes));
    size += declaration.length; if (size > TOOL_LIMITS.bytes) rejectTool('TOOL_SIZE_LIMIT');
    registry.set(fn.name, { name: fn.name, parameters: JSON.parse(JSON.stringify(parameters)), declaration });
  }
  return toolChoice === 'none' ? new Map() : registry;
}
function one(bytes, number, wire = 2, required = true) {
  const found = parse(bytes).filter(field => field.number === number);
  if (found.length > 1 || (required && !found.length) || (found.length && found[0].wire !== wire)) rejectTool('INVALID_NATIVE_TOOL_EVENT', 502);
  return found[0]?.payload;
}
function nativeText(bytes, number, max = TOOL_LIMITS.bytes, empty = false) {
  try { return string(utf8.decode(one(bytes, number)), max, empty); } catch { rejectTool('INVALID_NATIVE_TOOL_EVENT', 502); }
}
function scalar(bytes) { let value = 0n; for (const [i, byte] of bytes.entries()) value |= BigInt(byte & 127) << BigInt(7 * i); if (value > BigInt(Number.MAX_SAFE_INTEGER)) rejectTool('INVALID_NATIVE_TOOL_EVENT', 502); return Number(value); }
function googleValue(bytes, budget, depth) {
  tick(budget, depth); const fields = parse(bytes);
  if (fields.length !== 1) rejectTool('INVALID_NATIVE_ARGUMENTS', 502);
  const f = fields[0];
  if (f.number === 1 && f.wire === 0 && scalar(f.payload) === 0) return null;
  if (f.number === 2 && f.wire === 1) { const n = f.payload.readDoubleLE(); if (!Number.isFinite(n)) rejectTool('INVALID_NATIVE_ARGUMENTS', 502); return n; }
  if (f.number === 3 && f.wire === 2) return utf8.decode(f.payload);
  if (f.number === 4 && f.wire === 0) { const n = scalar(f.payload); if (n > 1) rejectTool('INVALID_NATIVE_ARGUMENTS', 502); return n === 1; }
  if (f.number === 5 && f.wire === 2) return googleStruct(f.payload, budget, depth + 1);
  if (f.number === 6 && f.wire === 2) return parse(f.payload).map(item => { if (item.number !== 1 || item.wire !== 2) rejectTool('INVALID_NATIVE_ARGUMENTS', 502); return googleValue(item.payload, budget, depth + 1); });
  rejectTool('INVALID_NATIVE_ARGUMENTS', 502);
}
function googleStruct(bytes, budget = { nodes: 0 }, depth = 0) {
  tick(budget, depth); const result = {};
  for (const item of parse(bytes)) {
    if (item.number !== 1 || item.wire !== 2) rejectTool('INVALID_NATIVE_ARGUMENTS', 502);
    const name = nativeText(item.payload, 1, 256, true);
    if (Object.hasOwn(result, name)) rejectTool('INVALID_NATIVE_ARGUMENTS', 502);
    Object.defineProperty(result, name, { value: googleValue(one(item.payload, 2), budget, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return result;
}
function validateArguments(value, schema, depth = 0) {
  if (depth > TOOL_LIMITS.depth) rejectTool('TOOL_SIZE_LIMIT');
  schema = literalSchema(schema);
  if (value === null && (schema.nullable || schema.type === 'null')) return;
  const good = schema.type === 'object' ? object(value) : schema.type === 'array' ? Array.isArray(value) : schema.type === 'integer' ? Number.isSafeInteger(value) : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value) : schema.type === 'null' ? value === null : typeof value === schema.type;
  if (!good || (schema.enum && !schema.enum.includes(value))) rejectTool('NATIVE_ARGUMENT_SCHEMA_MISMATCH', 502);
  if (typeof value === 'number' && ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum))) rejectTool('NATIVE_ARGUMENT_SCHEMA_MISMATCH', 502);
  if (schema.type === 'object') {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) rejectTool('NATIVE_ARGUMENT_SCHEMA_MISMATCH', 502);
    for (const [key, child] of Object.entries(value)) {
      if (Object.hasOwn(props, key)) validateArguments(child, props[key], depth + 1);
      else if (schema.additionalProperties === false) rejectTool('NATIVE_ARGUMENT_SCHEMA_MISMATCH', 502);
    }
  }
  if (schema.type === 'array') for (const item of value) validateArguments(item, schema.items, depth + 1);
}
/** Shared schema validation for already structured legacy IPC arguments. */
export function validateConsumerToolArguments(value, schema) {
  validateArguments(value, schema);
}
/** PRIVATE result: operationId/functionId are never consumer-visible/loggable. */
export function decodeConsumerOperation(bytes, registry) {
  if (!Buffer.isBuffer(bytes) || bytes.length > TOOL_LIMITS.frameBytes) rejectTool('TOOL_SIZE_LIMIT', 502);
  const request = one(bytes, 1, 2, false), end = one(bytes, 2, 2, false);
  if (request !== undefined && end !== undefined) rejectTool('INVALID_NATIVE_TOOL_EVENT', 502);
  if (request === undefined) { if (end?.length === 0) return { ended: true }; rejectTool('INVALID_NATIVE_TOOL_EVENT', 502); }
  const id = one(request, 1), idFields = parse(id), binary = one(id, 1);
  if (idFields.length !== 1 || !binary.length || binary.length > 4096) rejectTool('INVALID_NATIVE_TOOL_EVENT', 502);
  if (parse(request).some(field => field.number === 2)) rejectTool('UNSUPPORTED_OPERATION_DEPENDENCIES', 502);
  const skip = one(request, 4, 0, false);
  if (skip && scalar(skip) !== 0) rejectTool('UNSUPPORTED_SKIP_RESULTS', 502);
  const calls=decodeClientFunctionCallArgs(one(one(request,3),1082),registry);
  return { ended:false,operationId:Buffer.from(id),calls };
}
/** PRIVATE common payload for ProcessQuery and Notify; never log returned IDs/args. */
export function decodeClientFunctionCallArgs(bytes,registry){
  if(!Buffer.isBuffer(bytes)||bytes.length>TOOL_LIMITS.frameBytes)rejectTool('TOOL_SIZE_LIMIT',502);
  const callFields=parse(bytes);
  if(!callFields.length||callFields.length>TOOL_LIMITS.calls||callFields.some(field=>field.number!==1||field.wire!==2))rejectTool('INVALID_NATIVE_TOOL_EVENT',502);
  const ids=new Set();
  return callFields.map(field=>{
    const name=nativeText(field.payload,1,64),functionId=nativeText(field.payload,2,4096);
    if(!registry.has(name))rejectTool('UNDECLARED_NATIVE_TOOL',502);
    if(ids.has(functionId))rejectTool('DUPLICATE_NATIVE_TOOL_ID',502);ids.add(functionId);
    const argumentsValue=googleStruct(one(field.payload,3,2,false)??Buffer.alloc(0));
    validateArguments(argumentsValue,registry.get(name).parameters);
    const argumentsJson=JSON.stringify(argumentsValue);
    if(Buffer.byteLength(argumentsJson)>TOOL_LIMITS.bytes)rejectTool('TOOL_SIZE_LIMIT',502);
    return {name,functionId,argumentsJson};
  });
}
function sequence(value) { if (!Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff) rejectTool('INVALID_TURN_SEQUENCE'); return v(1, value); }
/** Standard role:tool content is encoded verbatim as Beyond_Struct { output: string }
 * using Beyond Value string field 3.
 */
export function encodeConsumerResults(operation, contents, turnSequence) {
  if(!operation||operation.ended||!Buffer.isBuffer(operation.operationId))rejectTool('INVALID_TOOL_RESULTS');
  const responses=encodeClientFunctionCallResult(operation.calls,contents);
  const result=cat(m(1,operation.operationId),m(2,m(1,m(1002,responses))));
  return cat(sequence(turnSequence),m(1011,m(1,result)));
}
/** PRIVATE common result; names/IDs are copied from a decoded call, never minted. */
export function encodeClientFunctionCallResult(calls,contents){
  if(!Array.isArray(calls)||!calls.length||calls.length>TOOL_LIMITS.calls||!Array.isArray(contents)||contents.length!==calls.length)rejectTool('INVALID_TOOL_RESULTS');
  const ids=new Set();
  return cat(...calls.map((call,i)=>{
    const name=string(call?.name,64,false),functionId=string(call?.functionId,4096,false);
    if(ids.has(functionId))rejectTool('INVALID_TOOL_RESULTS');ids.add(functionId);
    return m(1,cat(s(1,name),s(2,functionId),m(3,m(1,cat(s(1,'output'),m(2,s(3,string(contents[i]))))))));
  }));
}
export const encodeConsumerResultsEnd = turnSequence => cat(sequence(turnSequence), m(1011, m(2, Buffer.alloc(0))));
export function buildConsumerToolInitial({ userText, images = [], systemText, tools = [], toolChoice = 'auto', turnSequence = 1, clientMetadata, identifiers, continuation, agentChat = false, clientToolsFeature = false, operationFeature = true, halfCloseFeature = false, localSession = false, clientToolsCapability = false, clientFunctionCapabilities = false, ownedDeviceId, modeCategory, thinkingLevel = ARGON_THINKING_LEVEL, temporaryChat = true, allowNativeTools = false } = {}, { maxInputBytes = TOOL_LIMITS.bytes } = {}) {
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > MAX_MESSAGE_BYTES) rejectTool('INVALID_NATIVE_INPUT_LIMIT');
  string(userText, maxInputBytes); if (systemText !== undefined) string(systemText); if (typeof allowNativeTools !== 'boolean') rejectTool('INVALID_NATIVE_TOOLS_PERMISSION'); if (allowNativeTools && tools.length) rejectTool('NATIVE_TOOLS_WITH_DECLARATIONS'); if (typeof agentChat !== 'boolean') rejectTool('INVALID_AGENT_CONTEXT'); if (typeof clientToolsFeature !== 'boolean') rejectTool('INVALID_CLIENT_TOOLS_FEATURE'); if (typeof operationFeature !== 'boolean') rejectTool('INVALID_OPERATION_FEATURE'); if (typeof halfCloseFeature !== 'boolean') rejectTool('INVALID_HALF_CLOSE_FEATURE'); if (typeof localSession !== 'boolean') rejectTool('INVALID_LOCAL_SESSION'); if (typeof clientToolsCapability !== 'boolean') rejectTool('INVALID_CLIENT_TOOLS_CAPABILITY'); if (typeof clientFunctionCapabilities !== 'boolean') rejectTool('INVALID_CLIENT_FUNCTION_CAPABILITIES');
  if (allowNativeTools && (!Array.isArray(images) || images.length)) rejectTool('NATIVE_SEARCH_IMAGES_UNSUPPORTED');
  if(ownedDeviceId!==undefined&&(typeof ownedDeviceId!=='string'||!/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/.test(ownedDeviceId)))rejectTool('INVALID_OWNED_DEVICE_ID');if(ownedDeviceId!==undefined&&!localSession)rejectTool('OWNED_DEVICE_REQUIRES_LOCAL_SESSION');
  const registry = compileConsumerTools(tools, toolChoice);if(localSession&&!registry.size)rejectTool('LOCAL_TOOLS_REQUIRED');if((clientToolsCapability||clientFunctionCapabilities)&&!registry.size)rejectTool('TOOL_CAPABILITY_REQUIRES_DECLARATIONS');
  if (halfCloseFeature && (!registry.size || !clientToolsFeature)) rejectTool('HALF_CLOSE_REQUIRES_CLIENT_TOOLS');
  if (!operationFeature && (!registry.size || !clientToolsFeature)) rejectTool('OPERATION_OMISSION_REQUIRES_CLIENT_TOOLS');
  if (halfCloseFeature && !operationFeature) rejectTool('HALF_CLOSE_REQUIRES_OPERATION_FEATURE');
  const metadata = { ...(clientMetadata ?? { clientType: 21, languageCode: 'en', interfaceLanguageCode: 'en', clientVersion: NATIVE_VERSION, clientInstanceId: crypto.randomUUID(), triggerType: 1, uiSource: 1 }), clientFunctionCapabilities };
  if (!Number.isSafeInteger(thinkingLevel) || thinkingLevel < 0 || thinkingLevel > 4) rejectTool('INVALID_THINKING_LEVEL');
  if (typeof temporaryChat !== 'boolean') rejectTool('INVALID_TEMPORARY_CHAT');
  const base = buildClientGenerate({ userText, images, systemText, identifiers, clientMetadata: metadata, temporaryChat });
  const desktopInfo = cat(...[...registry.values()].map(tool => m(2, tool.declaration)), ...(ownedDeviceId===undefined?[]:[s(6,ownedDeviceId)]), ...(clientToolsCapability ? [m(7, unsignedVarint(CLIENT_TOOLS_CAPABILITY))] : []));
  const requestedMode = modeCategory === undefined ? ARGON_MODE_CATEGORY : modeCategory;
  if (!Number.isSafeInteger(requestedMode) || requestedMode < 0 || requestedMode > 255) rejectTool('INVALID_MODE_CATEGORY');
  const template = cat(...parse(base).map(field => field.number === 15 ? v(15, registry.size || allowNativeTools ? 0 : 1) : field.raw), v(47, requestedMode), v(48, thinkingLevel), ...(agentChat ? [v(49, 1)] : []), ...(registry.size ? [m(51, cat(...(ownedDeviceId===undefined?[]:[s(1,ownedDeviceId)]),m(3, desktopInfo), ...(localSession ? [v(5, 1)] : [])))] : []));
  if (continuation !== undefined && !Buffer.isBuffer(continuation)) rejectTool('INVALID_OWN_CONTINUATION');
  // Proven empty InitialRequest.ext1013 marker; NOT an outer update carrier or declaration list.
  const initial = cat(m(1, buildRequestMetadata(metadata)), ...(continuation === undefined ? [] : [m(6, continuation)]), m(1001, m(1, template)), m(1004, Buffer.alloc(0)), ...(registry.size && operationFeature ? [m(1009, Buffer.alloc(0))] : []), ...(halfCloseFeature ? [m(1010, Buffer.alloc(0))] : []), ...(clientToolsFeature ? [m(1013, Buffer.alloc(0))] : []));
  return cat(sequence(turnSequence), m(1000, initial));
}
