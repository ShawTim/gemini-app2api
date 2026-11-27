import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePromptTools, compileOutputSchema, validatePromptToolArguments, validateOutputValue } from '../src/prompt-tool-schema.mjs';

const tool = (name, parameters) => ({type:'function',function:{name,parameters}});
const rejectsCode = (fn, code, param) => assert.throws(fn, e => e.code === code && (param === undefined || e.param === param));

test('compiles prompt tools with clones, defaults, names and function hints', () => {
  const schema={type:'object',properties:{title:{type:'string'},format:{type:'string'}},required:['title']};
  const tools=compilePromptTools([tool('hello',schema),{type:'function',function:{name:'bare',strict:true}}]);
  assert.deepEqual([...tools.keys()],['hello','bare']);
  assert.notEqual(tools.get('hello').parameters,schema);
  schema.properties.title.type='integer';
  assert.equal(tools.get('hello').parameters.properties.title.type,'string');
  assert.deepEqual(tools.get('bare').parameters,{type:'object'});
  rejectsCode(()=>compilePromptTools([tool('x',{}),tool('x',{})]),'INVALID_TOOL_DECLARATION');
  rejectsCode(()=>compilePromptTools([{type:'native'}]),'UNSUPPORTED_TOOL_TYPE');
  rejectsCode(()=>compilePromptTools([{type:'function',function:{name:'x',strict:'yes'}}]),'INVALID_TOOL_DECLARATION');
});

test('validates TodoWrite-shaped arrays and constrained strings and rejects bad arguments', () => {
  const schema={type:'object',properties:{todos:{type:'array',maxItems:3,items:{type:'object',properties:{content:{type:'string',minLength:1},status:{type:'string',enum:['pending','done']}},required:['content','status'],additionalProperties:false}}},required:['todos']};
  assert.equal(validatePromptToolArguments({todos:[{content:'do',status:'pending'}]},schema),true);
  rejectsCode(()=>validatePromptToolArguments({todos:[{content:'',status:'pending'}]},schema),'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  rejectsCode(()=>validatePromptToolArguments({todos:[{content:'x',status:'done'},{content:'x',status:'done'},{content:'x',status:'done'},{content:'x',status:'done'}]},schema),'TOOL_ARGUMENT_SCHEMA_MISMATCH');
});

test('supports object/string unions, nullable and nested array unions', () => {
  const schema={anyOf:[{type:'string',minLength:2},{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}]};
  assert.equal(validatePromptToolArguments({query:'ok'},schema),true);
  assert.equal(validatePromptToolArguments('ok',schema),true);
  rejectsCode(()=>validatePromptToolArguments(4,schema),'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  const nested={type:['null','object'],properties:{value:{oneOf:[{type:'array',items:{type:'integer'}},{type:'string',enum:['x']}]}}};
  assert.equal(validatePromptToolArguments(null,nested),true);
  assert.equal(validatePromptToolArguments({value:[1,2]},nested),true);
  assert.equal(validatePromptToolArguments({value:'x'},nested),true);
  rejectsCode(()=>validatePromptToolArguments({value:[1,'bad']},nested),'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  assert.equal(validatePromptToolArguments(null,{type:'string',nullable:true}),true);
});

test('supports constraints, additional property schemas, wildcard patterns, and local refs', () => {
  const s={type:'object',properties:{count:{type:'integer',minimum:2,maximum:8,multipleOf:2},name:{type:'string',minLength:1,maxLength:4}},required:['count','name'],additionalProperties:{type:'boolean'}};
  assert.equal(validatePromptToolArguments({count:4,name:'é',extra:true},s),true);
  rejectsCode(()=>validatePromptToolArguments({count:3,name:'a'},s),'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  const ref={$defs:{word:{type:'string',enum:['yes']}},type:'object',properties:{answer:{$ref:'#/$defs/word'}},required:['answer']};
  assert.equal(validatePromptToolArguments({answer:'yes'},ref),true);
  rejectsCode(()=>validatePromptToolArguments({answer:'no'},ref),'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  rejectsCode(()=>compilePromptTools([tool('bad',{$ref:'https://example.invalid/schema'})]),'UNSUPPORTED_TOOL_SCHEMA');
});

test('does not execute regex hints and treats title/format as ordinary property keys', () => {
  const s={type:'object',properties:{title:{type:'number'},format:{type:'string'}},required:['title'],pattern:'^(a+)+$'};
  assert.equal(validatePromptToolArguments({title:2,format:'anything'},s),true);
  rejectsCode(()=>validatePromptToolArguments({title:'wrong',format:'x'},s),'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  const unsafe={type:'object',patternProperties:{'(a+)+$':{type:'number'}}};
  assert.equal(validatePromptToolArguments({aaaa:'ignored'},unsafe),true);
});

test('enforces byte, depth, node, tool and union-work bounds', () => {
  // Large real-world tool suites (e.g. 154 MCP/agent tools up to 256) compile cleanly
  assert.equal(compilePromptTools(Array.from({length:154},(_,i)=>tool(`t${i}`,{type:'object',properties:{arg:{type:'string'}}}))).size,154);
  assert.equal(compilePromptTools(Array.from({length:256},(_,i)=>tool(`t${i}`,{}))).size,256);
  rejectsCode(()=>compilePromptTools(Array.from({length:257},(_,i)=>tool(`t${i}`,{}))),'TOOL_SIZE_LIMIT','tools.count');
  // Per-tool schema stays bounded to 256 KiB / 4096 nodes; aggregate declarations bounded to 512 KiB / 16384 nodes
  rejectsCode(()=>compilePromptTools([tool('big',{type:'string',description:'x'.repeat(270000)})]),'TOOL_SIZE_LIMIT','tools.bytes');
  rejectsCode(()=>compilePromptTools(Array.from({length:3},(_,i)=>tool(`b${i}`,{type:'string',description:'x'.repeat(200000)}))),'TOOL_SIZE_LIMIT','tools.bytes');
  let deep={type:'string'}; for(let i=0;i<18;i++) deep={type:'array',items:deep};
  rejectsCode(()=>compilePromptTools([tool('deep',deep)]),'TOOL_SIZE_LIMIT','tools.depth');
  const wide={type:'object',properties:Object.fromEntries(Array.from({length:2100},(_,i)=>[`p${i}`,{type:'string'}]))};
  rejectsCode(()=>compilePromptTools([tool('wide',wide)]),'TOOL_SIZE_LIMIT','tools.nodes');
  const medium=()=>({type:'object',properties:Object.fromEntries(Array.from({length:100},(_,i)=>[`p${i}`,{type:'string'}]))});
  rejectsCode(()=>compilePromptTools(Array.from({length:90},(_,i)=>tool(`m${i}`,medium()))),'TOOL_SIZE_LIMIT','tools.nodes');
  const defs={leaf:{type:'integer'}};
  for(let i=0;i<9;i++)defs['n'+i]={anyOf:Array.from({length:4},()=>({$ref:'#/$defs/'+(i?'n'+(i-1):'leaf')}))};
  rejectsCode(()=>validatePromptToolArguments('wrong',{$defs:defs,$ref:'#/$defs/n8'}), 'TOOL_ARGUMENT_SCHEMA_MISMATCH');
});

test('nullable enums, JSON literals, unique objects, reference siblings and wildcard intersections stay enforced', () => {
  assert.equal(validatePromptToolArguments(null,{type:'string',enum:['yes'],nullable:true}),true);
  rejectsCode(()=>validatePromptToolArguments({'0':1},{const:[1]}),'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  rejectsCode(()=>validatePromptToolArguments([{a:1,b:2},{b:2,a:1}],{type:'array',uniqueItems:true}),'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  const ref={$defs:{word:{type:'string'}},$ref:'#/$defs/word',maxLength:2};
  rejectsCode(()=>validatePromptToolArguments('long',ref),'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  rejectsCode(()=>validatePromptToolArguments({x:1},{type:'object',properties:{x:{type:'number'}},patternProperties:{'^(.*)$':{type:'boolean'}}}),'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  assert.equal(validatePromptToolArguments([1],{type:'array',prefixItems:[{type:'integer'}],items:false}),true);
  rejectsCode(()=>validatePromptToolArguments([1,2],{type:'array',prefixItems:[{type:'integer'}],items:false}),'TOOL_ARGUMENT_SCHEMA_MISMATCH');
});

test('compiled schemas are deeply frozen and private fast-path never weakens uncompiled schema validation', () => {
  const compiled = compilePromptTools([tool('fn', { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] })]);
  const entry = compiled.get('fn');
  assert.equal(Object.isFrozen(entry), true);
  assert.equal(Object.isFrozen(entry.parameters), true);
  assert.equal(Object.isFrozen(entry.parameters.properties), true);
  assert.equal(Object.isFrozen(entry.parameters.properties.n), true);
  assert.throws(() => { entry.parameters.properties.n.type = 'string'; }, TypeError);
  assert.equal(validatePromptToolArguments({ n: 42 }, entry.parameters), true);
  rejectsCode(() => validatePromptToolArguments({ n: 'bad' }, entry.parameters), 'TOOL_ARGUMENT_SCHEMA_MISMATCH');
  // Arbitrary uncompiled invalid schema passed directly is still rejected.
  rejectsCode(() => validatePromptToolArguments({ n: 1 }, { type: 'bogus' }), 'UNSUPPORTED_TOOL_SCHEMA');
  // Valid boolean root schemas (true / false) compile cleanly and preserve runtime validation semantics.
  const boolCompiled = compilePromptTools([tool('allow_all', true), tool('deny_all', false)]);
  assert.equal(boolCompiled.get('allow_all').parameters, true);
  assert.equal(boolCompiled.get('deny_all').parameters, false);
  assert.equal(validatePromptToolArguments({}, boolCompiled.get('allow_all').parameters), true);
  rejectsCode(() => validatePromptToolArguments({}, boolCompiled.get('deny_all').parameters), 'TOOL_ARGUMENT_SCHEMA_MISMATCH');

  // compileOutputSchema returns a deeply frozen schema and stays isolated from compiledToolSchemas.
  const compiledOut = compileOutputSchema({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false });
  assert.equal(Object.isFrozen(compiledOut), true);
  assert.equal(Object.isFrozen(compiledOut.properties.ok), true);
  assert.equal(validateOutputValue({ ok: true }, compiledOut), true);
  rejectsCode(() => validateOutputValue({ ok: 'nope' }, compiledOut), 'STRUCTURED_OUTPUT_SCHEMA_MISMATCH');
  rejectsCode(() => validateOutputValue({ ok: true }, { type: 'bogus' }), 'UNSUPPORTED_OUTPUT_SCHEMA');
  // Cross-WeakSet isolation: a tool-compiled schema with an unsupported output keyword is still rejected by validateOutputValue.
  const toolOnly = compilePromptTools([tool('loose', { type: 'object', properties: { s: { type: 'string', pattern: '^[a-z]+$' } } })]);
  rejectsCode(() => validateOutputValue({ s: 'abc' }, toolOnly.get('loose').parameters), 'UNSUPPORTED_OUTPUT_SCHEMA');
});
