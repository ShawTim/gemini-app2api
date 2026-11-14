const LIMITS = { bytes: 256 * 1024, depth: 16, nodes: 4096, tools: 64, work: 65536 };

function error(code, message = code, status = 400) {
  const e = new Error(message); e.code = code; e.status = status; return e;
}
const declaration = (message) => error('INVALID_TOOL_DECLARATION', message);
const badSchema = (message) => error('UNSUPPORTED_TOOL_SCHEMA', message);

function jsonTree(value, state, depth = 0, seen = new Set(), maxDepth = LIMITS.depth) {
  if (++state.nodes > LIMITS.nodes || depth > maxDepth) throw error('TOOL_SIZE_LIMIT');
  const add = n => { state.bytes = (state.bytes || 0) + n; if (state.bytes > LIMITS.bytes) throw error('TOOL_SIZE_LIMIT'); };
  if (typeof value === 'string') { if (Buffer.from(value).toString('utf8') !== value) throw error('INVALID_TOOL_STRING'); add(Buffer.byteLength(value)); return; }
  if (value === null || typeof value === 'boolean') { add(4); return; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw declaration('Non-finite JSON number'); add(8); return; }
  if (typeof value !== 'object') throw declaration('Value is not plain JSON');
  if (seen.has(value)) throw declaration('Cyclic JSON value');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw declaration('Non-plain JSON object');
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) { if (!Object.hasOwn(value, i)) throw declaration('Sparse array'); jsonTree(value[i], state, depth + 1, seen, maxDepth); }
  } else for (const key of Object.keys(value)) { add(Buffer.byteLength(key)); jsonTree(value[key], state, depth + 1, seen, maxDepth); }
  seen.delete(value);
}
function clone(v) { return Array.isArray(v) ? v.map(clone) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v; }
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const SCHEMA_ANNOTATIONS = new Set([
  '$schema', '$id', 'title', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', 'format',
]);
export function stripSchemaAnnotations(value, seen = new Map()) {
  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return seen.get(value);
  const out = {};
  seen.set(value, out);
  for (const [key, child] of Object.entries(value)) {
    if (SCHEMA_ANNOTATIONS.has(key)) continue;
    if (['properties', '$defs', 'definitions', 'patternProperties'].includes(key) && isPlainObject(child)) {
      out[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, stripSchemaAnnotations(schema, seen)]));
    } else if (['items', 'additionalProperties', 'additionalItems', 'not', 'if', 'then', 'else'].includes(key)) {
      out[key] = Array.isArray(child) ? child.map((item) => stripSchemaAnnotations(item, seen)) : stripSchemaAnnotations(child, seen);
    } else if (['anyOf', 'oneOf', 'allOf', 'prefixItems'].includes(key) && Array.isArray(child)) {
      out[key] = child.map((item) => stripSchemaAnnotations(item, seen));
    } else {
      out[key] = child;
    }
  }
  return out;
}
const types = new Set(['null','boolean','object','array','number','integer','string']);
function schemaType(s) {
  if (!own(s, 'type')) return null;
  const ts = Array.isArray(s.type) ? s.type : [s.type];
  if (!ts.length || ts.some(t => typeof t !== 'string' || !types.has(t)) || new Set(ts).size !== ts.length) throw badSchema('Invalid schema type');
  return ts;
}
function nonnegativeInt(s, k) { if (own(s,k) && (!Number.isSafeInteger(s[k]) || s[k] < 0)) throw badSchema(`Invalid ${k}`); }
function finite(s,k) { if (own(s,k) && (typeof s[k] !== 'number' || !Number.isFinite(s[k]))) throw badSchema(`Invalid ${k}`); }
function literalValid(v) { try { jsonTree(v,{nodes:0}); return true; } catch { return false; } }
const DIRECT_SCHEMA_STEP_KEYS = new Set(['not', 'additionalProperties', 'additionalItems']);
const MAPPED_SCHEMA_STEP_KEYS = new Set(['properties', '$defs', 'definitions', 'patternProperties']);
const ARRAY_SCHEMA_STEP_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

function isCanonicalIndexToken(part) {
  return /^(?:0|[1-9]\d*)$/.test(part);
}

function definition(root, ref, { strictPointer = false } = {}) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) throw badSchema('External references are unsupported');
  const parts = ref.slice(2).split('/').map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!['$defs', 'definitions'].includes(parts[0]) || parts.length < 2 || parts.length > 36) throw badSchema('Unknown local reference');
  let target = root;
  for (let i = 0; i < parts.length;) {
    const part = parts[i];
    if (!target || typeof target !== 'object' || Array.isArray(target) || !own(target, part)) throw badSchema('Unknown local reference');
    if (i === 0) {
      const container = target[part];
      const defName = parts[1];
      if (!container || typeof container !== 'object' || Array.isArray(container) || !own(container, defName)) throw badSchema('Unknown local reference');
      target = container[defName];
      i = 2;
      continue;
    }
    if (DIRECT_SCHEMA_STEP_KEYS.has(part)) {
      target = target[part];
      i += 1;
      continue;
    }
    if (part === 'items') {
      if (Array.isArray(target.items)) {
        if (i + 1 >= parts.length || !isCanonicalIndexToken(parts[i + 1])) throw badSchema('Unknown local reference');
        const idx = Number(parts[i + 1]);
        if (idx >= target.items.length) throw badSchema('Unknown local reference');
        target = target.items[idx];
        i += 2;
        continue;
      }
      target = target.items;
      i += 1;
      continue;
    }
    if (MAPPED_SCHEMA_STEP_KEYS.has(part)) {
      if (i + 1 >= parts.length) throw badSchema('Unknown local reference');
      const key = parts[i + 1];
      if (part === 'patternProperties' && strictPointer && key !== '^(.*)$' && key !== '^.*$') {
        throw badSchema('Unsupported patternProperties pattern');
      }
      const map = target[part];
      if (!map || typeof map !== 'object' || Array.isArray(map) || !own(map, key)) throw badSchema('Unknown local reference');
      target = map[key];
      i += 2;
      continue;
    }
    if (ARRAY_SCHEMA_STEP_KEYS.has(part)) {
      if (i + 1 >= parts.length || !isCanonicalIndexToken(parts[i + 1])) throw badSchema('Unknown local reference');
      const arr = target[part];
      const idx = Number(parts[i + 1]);
      if (!Array.isArray(arr) || idx >= arr.length) throw badSchema('Unknown local reference');
      target = arr[idx];
      i += 2;
      continue;
    }
    throw badSchema('Invalid reference target');
  }
  if (typeof target !== 'boolean' && (!target || typeof target !== 'object' || Array.isArray(target))) throw badSchema('Invalid reference target');
  return target;
}

const OUTPUT_SCHEMA_KEYWORDS = new Set([
  '$ref', '$defs', 'definitions',
  'type', 'nullable', 'const', 'enum',
  'allOf', 'anyOf', 'oneOf', 'not',
  'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'items', 'prefixItems', 'additionalItems',
  'minProperties', 'maxProperties', 'required', 'properties', 'additionalProperties', 'patternProperties',
]);
const OUTPUT_SCHEMA_METADATA = new Set([
  ...SCHEMA_ANNOTATIONS,
  'description',
  '$comment',
]);

function checkSchema(root, { rejectUnsupportedKeywords = false } = {}) {
  const defs = new Map();
  const walked = new WeakSet();
  function walk(s, depth=0, visited=new Set()) {
    if (depth > LIMITS.depth) throw error('TOOL_SIZE_LIMIT');
    if (typeof s === 'boolean') return;
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw badSchema('Schema must be an object');
    if (visited.has(s)) throw badSchema('Cyclic schema'); visited.add(s); walked.add(s);
    if (rejectUnsupportedKeywords) {
      for (const k of Object.keys(s)) {
        if (!OUTPUT_SCHEMA_KEYWORDS.has(k) && !OUTPUT_SCHEMA_METADATA.has(k)) {
          throw badSchema(`Unsupported output schema keyword: ${/^[A-Za-z0-9_$-]{1,64}$/.test(k) ? k : 'unknown'}`);
        }
      }
      if (own(s, 'description') && typeof s.description !== 'string') throw badSchema('Invalid schema description');
      if (own(s, '$comment') && typeof s.$comment !== 'string') throw badSchema('Invalid schema $comment');
      if (own(s, 'additionalItems') && !Array.isArray(s.items)) throw badSchema('additionalItems requires tuple items array');
      if (own(s, 'prefixItems') && Array.isArray(s.items)) throw badSchema('Cannot combine prefixItems with tuple items array');
    }
    schemaType(s);
    if (own(s,'nullable') && typeof s.nullable !== 'boolean') throw badSchema('Invalid nullable');
    if (own(s,'const') && !literalValid(s.const)) throw badSchema('Invalid const');
    if (own(s,'enum') && (!Array.isArray(s.enum) || !s.enum.length || s.enum.some(v => !literalValid(v)))) throw badSchema('Invalid enum');
    for (const k of ['minLength','maxLength','minItems','maxItems','minProperties','maxProperties']) nonnegativeInt(s,k);
    for (const k of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf']) finite(s,k);
    if (s.multipleOf !== undefined && s.multipleOf <= 0) throw badSchema('Invalid multipleOf');
    if (typeof s.uniqueItems === 'string' || typeof s.uniqueItems === 'number' || (own(s,'uniqueItems') && typeof s.uniqueItems !== 'boolean')) throw badSchema('Invalid uniqueItems');
    if (own(s,'required') && (!Array.isArray(s.required) || s.required.some(x => typeof x !== 'string') || new Set(s.required).size !== s.required.length)) throw badSchema('Invalid required');
    if (own(s,'properties') && (!s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties))) throw badSchema('Invalid properties');
    if (own(s,'additionalProperties') && typeof s.additionalProperties !== 'boolean' && (!s.additionalProperties || typeof s.additionalProperties !== 'object' || Array.isArray(s.additionalProperties))) throw badSchema('Invalid additionalProperties');
    for (const k of ['anyOf','oneOf','allOf']) if (own(s,k) && (!Array.isArray(s[k]) || !s[k].length)) throw badSchema(`Invalid ${k}`);
    if (own(s,'items') && typeof s.items !== 'boolean' && (!s.items || typeof s.items !== 'object')) throw badSchema('Invalid items');
    if (own(s,'prefixItems') && !Array.isArray(s.prefixItems)) throw badSchema('Invalid prefixItems');
    for (const k of ['$defs','definitions']) if (own(s,k) && (!s[k] || typeof s[k] !== 'object' || Array.isArray(s[k]))) throw badSchema('Invalid definitions');
    if (own(s,'patternProperties') && (!s.patternProperties || typeof s.patternProperties !== 'object' || Array.isArray(s.patternProperties))) throw badSchema('Invalid patternProperties');
    if (own(s,'$defs') && s.$defs && typeof s.$defs==='object') for (const [k,v] of Object.entries(s.$defs)) defs.set(`/$defs/${k}`,v);
    if (own(s,'definitions') && s.definitions && typeof s.definitions==='object') for (const [k,v] of Object.entries(s.definitions)) defs.set(`/definitions/${k}`,v);
    for (const k of ['properties','$defs','definitions']) if (s[k] && typeof s[k]==='object') for (const v of Object.values(s[k])) walk(v,depth+1,visited);
    for (const k of ['items','additionalProperties','additionalItems','not']) if (own(s,k)) { const children = k === 'items' && Array.isArray(s[k]) ? s[k] : [s[k]]; for (const child of children) walk(child,depth+1,visited); }
    if (s.prefixItems) for (const child of s.prefixItems) walk(child,depth+1,visited);
    for (const k of ['anyOf','oneOf','allOf']) if (s[k]) for (const v of s[k]) walk(v,depth+1,visited);
    if (s.patternProperties && typeof s.patternProperties==='object' && !Array.isArray(s.patternProperties)) for (const [p,v] of Object.entries(s.patternProperties)) { if (p !== '^(.*)$' && p !== '^.*$') { if (rejectUnsupportedKeywords) throw badSchema('Unsupported patternProperties pattern'); continue; } walk(v,depth+1,visited); }
    visited.delete(s);
  }
  walk(root);
  // Validate all local references syntactically and resolve only known definition pointers.
  function refs(s, seen=new Set()) {
    if (!s || typeof s!=='object' || seen.has(s)) return; seen.add(s);
    if (own(s,'$ref')) {
      const target = definition(root, s.$ref, { strictPointer: rejectUnsupportedKeywords });
      if (target && typeof target === 'object' && !walked.has(target)) walk(target, 0, new Set());
      refs(target, seen);
    }
    for (const k of ['properties','$defs','definitions']) if (s[k] && typeof s[k]==='object') for(const v of Object.values(s[k])) refs(v,seen);
    for (const k of ['items','additionalProperties','additionalItems','not']) if (own(s,k)) { const children = k === 'items' && Array.isArray(s[k]) ? s[k] : [s[k]]; for (const child of children) refs(child,seen); }
    if (s.prefixItems) for (const child of s.prefixItems) refs(child,seen);
    for (const k of ['anyOf','oneOf','allOf']) if(s[k]) for(const v of s[k]) refs(v,seen);
    if(s.patternProperties && typeof s.patternProperties==='object') for(const [p,v] of Object.entries(s.patternProperties)) if(p==='^(.*)$'||p==='^.*$') refs(v,seen);
  }
  refs(root);
}

// Unknown optional metadata/validation keywords are ignored deliberately; known
// constraints above are checked strictly. Arbitrary regex/pattern hints are never executed.
export function compilePromptTools(tools = []) {
  if (!Array.isArray(tools)) throw declaration('Tools must be an array');
  if (tools.length > LIMITS.tools) throw error('TOOL_SIZE_LIMIT');
  const state={nodes:0}; jsonTree(tools,state,0,new Set(),LIMITS.depth * 3 + 4);
  let text; try { text = JSON.stringify(tools); } catch { throw declaration('Tools are not JSON serializable'); }
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > LIMITS.bytes) throw error('TOOL_SIZE_LIMIT');
  const out = new Map();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool) || tool.type !== 'function') throw error('UNSUPPORTED_TOOL_TYPE');
    for (const k of Object.keys(tool)) if (!['type','function'].includes(k)) throw declaration(`Unexpected tool key ${k}`);
    const fn=tool.function;
    if (!fn || typeof fn!=='object' || Array.isArray(fn)) throw declaration('Invalid function declaration');
    for(const k of Object.keys(fn)) if(!['name','description','parameters','strict'].includes(k)) throw declaration(`Unexpected function key ${k}`);
    if(typeof fn.name!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(fn.name)) throw declaration('Invalid function name');
    if(out.has(fn.name)) throw declaration('Duplicate function name');
    if(own(fn,'description')&&typeof fn.description!=='string') throw declaration('Invalid description');
    if(own(fn,'strict')&&typeof fn.strict!=='boolean') throw declaration('Invalid strict hint');
    const parameters=own(fn,'parameters')?fn.parameters:{type:'object'};
    checkSchema(parameters);
    out.set(fn.name,{name:fn.name,parameters:clone(parameters)});
  }
  return out;
}

function mapOutputSchemaError(e) {
  if (e?.code === 'TOOL_SIZE_LIMIT') return error('OUTPUT_SCHEMA_SIZE_LIMIT', e.message || 'Output schema exceeds size limit', 400);
  if (e?.code === 'UNSUPPORTED_TOOL_SCHEMA') return error('UNSUPPORTED_OUTPUT_SCHEMA', e.message || 'Unsupported output schema', 400);
  return error('INVALID_RESPONSE_FORMAT', e?.message || 'Invalid output schema', 400);
}

/** Validate and clone a standalone structured output JSON Schema object. */
export function compileOutputSchema(schema) {
  if (!isPlainObject(schema)) throw error('INVALID_RESPONSE_FORMAT', 'Output schema must be a plain JSON object', 400);
  try {
    jsonTree(schema, { nodes: 0 }, 0, new Set(), LIMITS.depth * 3 + 4);
  } catch (e) {
    throw mapOutputSchemaError(e);
  }
  let text;
  try { text = JSON.stringify(schema); } catch { throw error('INVALID_RESPONSE_FORMAT', 'Output schema is not JSON serializable', 400); }
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > LIMITS.bytes) {
    throw error('OUTPUT_SCHEMA_SIZE_LIMIT', 'Output schema exceeds 256 KiB budget', 400);
  }
  try {
    checkSchema(schema, { rejectUnsupportedKeywords: true });
  } catch (e) {
    throw error(e?.code === 'TOOL_SIZE_LIMIT' ? 'OUTPUT_SCHEMA_SIZE_LIMIT' : 'UNSUPPORTED_OUTPUT_SCHEMA', e?.message || 'Unsupported output schema', 400);
  }
  return clone(schema);
}

function parseFiniteDecimal(num) {
  if (num === 0) return { coeff: 0n, exp: 0 };
  const raw = Math.abs(num).toString();
  const eIdx = raw.indexOf('e');
  const mantissa = eIdx >= 0 ? raw.slice(0, eIdx) : raw;
  const baseExp = eIdx >= 0 ? Number.parseInt(raw.slice(eIdx + 1), 10) : 0;
  const dotIdx = mantissa.indexOf('.');
  const fracLen = dotIdx >= 0 ? mantissa.length - dotIdx - 1 : 0;
  const digits = dotIdx >= 0 ? mantissa.slice(0, dotIdx) + mantissa.slice(dotIdx + 1) : mantissa;
  return { coeff: BigInt(digits), exp: baseExp - fracLen };
}

function isExactMultipleOf(value, multiple) {
  if (value === 0) return true;
  if (!Number.isFinite(value) || !Number.isFinite(multiple) || multiple <= 0) return false;
  const v = parseFiniteDecimal(value);
  const m = parseFiniteDecimal(multiple);
  const expDiff = Math.abs(v.exp - m.exp);
  if (expDiff > 1000) return false;
  const scale = 10n ** BigInt(expDiff);
  const vCoeff = v.exp > m.exp ? v.coeff * scale : v.coeff;
  const mCoeff = m.exp > v.exp ? m.coeff * scale : m.coeff;
  return mCoeff !== 0n && vCoeff % mCoeff === 0n;
}

function validateValueAgainstSchema(value, schema, mismatchCode, mismatchMessage, { strictApplicability = false } = {}) {
  let work=LIMITS.work, exhausted=false;
  const mismatch=()=>{ throw error(mismatchCode,mismatchMessage,502); };
  const take=(n=1)=>{ work-=n; if(work<0){exhausted=true;mismatch();} };
  function equal(a,b) {
    take();
    if(typeof a==='string'&&typeof b==='string') take(Math.ceil((a.length+b.length)/64));
    if(a===b)return true;
    if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
    const ak=Object.keys(a),bk=Object.keys(b);
    return ak.length===bk.length&&ak.every(k=>own(b,k)&&equal(a[k],b[k]));
  }
  function canonical(v) {
    take();
    if(typeof v==='string')take(Math.ceil(v.length/64));
    if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
    if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
    return JSON.stringify(v);
  }
  try { jsonTree(value,{nodes:0}); } catch { mismatch(); }
  const root=schema;
  function visit(v,s,depth=0) {
    take(); if(depth>LIMITS.depth){exhausted=true;mismatch();}
    if(s===true)return;if(s===false)mismatch();
    if(v===null&&s.nullable===true)return;
    if(own(s,'$ref'))visit(v,definition(root,s.$ref,{strictPointer:strictApplicability}),depth+1);
    if(own(s,'const')&&!equal(v,s.const))mismatch();
    if(s.enum&&!s.enum.some(x=>equal(v,x)))mismatch();
    if(s.allOf)for(const x of s.allOf)visit(v,x,depth+1);
    if(own(s,'not')){let matched=true;try{visit(v,s.not,depth+1);}catch(e){if(e.code!==mismatchCode||exhausted)throw e;matched=false;}if(matched)mismatch();}
    for(const k of ['anyOf','oneOf'])if(s[k]){let n=0;for(const x of s[k]){try{visit(v,x,depth+1);n++;if(k==='anyOf')break;}catch(e){if(e.code!==mismatchCode||exhausted)throw e;}}if(k==='anyOf'?n<1:n!==1)mismatch();}
    let ts=schemaType(s);if(!ts&&!strictApplicability)ts=s.properties||s.required||s.additionalProperties!==undefined||s.patternProperties?['object']:null;
    const match=t=>t==='null'?v===null:t==='boolean'?typeof v==='boolean':t==='string'?typeof v==='string':t==='number'?typeof v==='number'&&Number.isFinite(v):t==='integer'?Number.isSafeInteger(v):t==='array'?Array.isArray(v):t==='object'?v!==null&&typeof v==='object'&&!Array.isArray(v):false;
    if(ts&&!ts.some(match))mismatch();
    if(typeof v==='string'){const n=[...v].length;if(s.minLength!==undefined&&n<s.minLength||s.maxLength!==undefined&&n>s.maxLength)mismatch();}
    if(typeof v==='number'){if(s.minimum!==undefined&&v<s.minimum||s.maximum!==undefined&&v>s.maximum||s.exclusiveMinimum!==undefined&&v<=s.exclusiveMinimum||s.exclusiveMaximum!==undefined&&v>=s.exclusiveMaximum||s.multipleOf!==undefined&&!isExactMultipleOf(v,s.multipleOf))mismatch();}
    if(Array.isArray(v)){
      if(s.minItems!==undefined&&v.length<s.minItems||s.maxItems!==undefined&&v.length>s.maxItems)mismatch();
      if(s.uniqueItems&&new Set(v.map(canonical)).size!==v.length)mismatch();
      const prefix=s.prefixItems||(Array.isArray(s.items)?s.items:[]);
      for(let i=0;i<Math.min(v.length,prefix.length);i++)visit(v[i],prefix[i],depth+1);
      const rest=Array.isArray(s.items)?s.additionalItems:s.items;
      if(rest!==undefined)for(let i=prefix.length;i<v.length;i++)visit(v[i],rest,depth+1);
    }
    if(v&&typeof v==='object'&&!Array.isArray(v)){
      const keys=Object.keys(v);if(s.minProperties!==undefined&&keys.length<s.minProperties||s.maxProperties!==undefined&&keys.length>s.maxProperties)mismatch();
      for(const r of s.required||[])if(!own(v,r))mismatch();
      for(const[k,x]of Object.entries(v)){
        let covered=false;
        if(s.properties&&own(s.properties,k)){visit(x,s.properties[k],depth+1);covered=true;}
        for(const[p,ps]of Object.entries(s.patternProperties||{}))if(p==='^(.*)$'||p==='^.*$'){visit(x,ps,depth+1);covered=true;}
        if(!covered&&s.additionalProperties!==undefined)visit(x,s.additionalProperties,depth+1);
      }
    }
  }
  visit(value,schema);return true;
}

export function validatePromptToolArguments(value, schema) {
  jsonTree(schema,{nodes:0},0,new Set(),LIMITS.depth * 3 + 4);
  checkSchema(schema);
  return validateValueAgainstSchema(value, schema, 'TOOL_ARGUMENT_SCHEMA_MISMATCH', 'Tool arguments do not match schema');
}

/** Validate parsed structured output JSON against a bounded JSON Schema. */
export function validateOutputValue(value, schema) {
  try {
    jsonTree(schema, { nodes: 0 }, 0, new Set(), LIMITS.depth * 3 + 4);
    checkSchema(schema, { rejectUnsupportedKeywords: true });
  } catch (e) {
    throw mapOutputSchemaError(e);
  }
  return validateValueAgainstSchema(value, schema, 'STRUCTURED_OUTPUT_SCHEMA_MISMATCH', 'Structured output does not match schema', { strictApplicability: true });
}
