// Fresh scoped tests: real gateway/provider/splitter with synthetic native frames.
// No historical tests, real credentials, upstream network, or caller tool execution.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StateStore, defaults } from '../src/gateway/state.mjs';
import { createGateway } from '../src/gateway/app.mjs';
import { NativeDirectProvider } from '../src/native-provider.mjs';
import { createResponseDelivery } from '../src/gateway/response-delivery.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
const scratch = process.env.PI_SCRATCH_DIR; assert.ok(scratch && path.isAbsolute(scratch));
const directory = fs.mkdtempSync(path.join(scratch, 'nonmonotonic-boundary-'));
const state = Object.create(StateStore.prototype);
Object.assign(state, { directory, runtimeAdminRequired: false, runtimeAdmin: null, save() {},
  data: { version: 1, admin: null, settings: { ...defaults, host: '127.0.0.1', port: 0 }, accounts: [], keys: [], profile: {} } });
const key = state.createKey('synthetic snapshot boundary');
const accounts = { list: () => [{ id: 'synthetic', enabled: true, status: 'ready', authenticationStatus: 'signed_in' }], getValidAccessToken: async () => 'synthetic-only', recordProviderSuccess() {}, recordUpstreamError() {}, close() {} };
const str = (n, s) => m(n, Buffer.from(s));
const frame = ({ text, id = 'same-id', complete = false }) => m(1003, m(1, Buffer.concat([
  m(1, Buffer.concat([...(id == null ? [] : [str(1, id)]), m(2, str(1, text))])), v(9, complete ? 1 : 0), v(41, 8), v(42, 2) ])));
const tools = [{ type: 'function', function: { name: 'probe', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }];
const tool = value => '```tool_call\n' + JSON.stringify({ name: 'probe', arguments: { value } }) + '\n```\n';
const short = 'OLD_DRAFT', revised = 'NEW_FINAL', oldLong = 'O'.repeat(2048), newLong = 'N'.repeat(2600);
const cases = [
  { name: 'held_rewrite', snapshots: [{ text: short }, { text: revised, complete: true }], text: revised, revisions: 1 },
  { name: 'held_to_long', snapshots: [{ text: short }, { text: newLong, complete: true }], text: newLong, revisions: 1 },
  { name: 'exact_2047', snapshots: [{ text: 'a'.repeat(2047) }, { text: revised, complete: true }], text: revised, revisions: 1 },
  { name: 'utf8_2046', snapshots: [{ text: '中'.repeat(682) }, { text: revised, complete: true }], text: revised, revisions: 1 },
  { name: 'several_revisions', snapshots: [{ text: 'draft1' }, { text: 'draft2' }, { text: revised, complete: true }], text: revised, revisions: 2 },
  { name: 'shrink_then_append', snapshots: [{ text: 'old longish draft' }, { text: 'new' }, { text: 'new answer', complete: true }], text: 'new answer', revisions: 1 },
  { name: 'empty_replacement_then_new', snapshots: [{ text: short }, { text: '' }, { text: revised, complete: true }], text: revised, revisions: 1 },
  { name: 'tool_prefix_removed', snapshots: [{ text: 'old text\n```tool_call\n{"name":"probe",' }, { text: revised, complete: true }], text: revised, revisions: 1 },
  { name: 'prior_complete_invalidated', snapshots: [{ text: short, complete: true }, { text: revised }], text: revised, error: 'INCOMPLETE_NATIVE_RESPONSE' },
  { name: 'anonymous_revision', snapshots: [{ text: short, id: null }, { text: revised, id: null, complete: true }], text: short, error: 'NON_MONOTONIC_NATIVE_RESPONSE', site: 'snapshot_identity' },
  { name: 'new_identity_cannot_authorize_old', snapshots: [{ text: short, id: null }, { text: revised, complete: true }], text: short, error: 'NON_MONOTONIC_NATIVE_RESPONSE', site: 'snapshot_identity' },
  { name: 'changed_identity', snapshots: [{ text: short }, { text: revised, id: 'other-id', complete: true }], text: short, error: 'INVALID_NATIVE_RESPONSE' },
  { name: 'missing_identity', snapshots: [{ text: short }, { text: revised, id: null, complete: true }], text: short, error: 'INVALID_NATIVE_RESPONSE' },
  { name: 'anonymous_append', snapshots: [{ text: 'old', id: null }, { text: 'old new', id: null, complete: true }], text: 'old new', revisions: 0 },
  { name: 'published_2048', snapshots: [{ text: oldLong }, { text: newLong, complete: true }], text: newLong, revisions: 1, streamingError: 'NON_MONOTONIC_NATIVE_RESPONSE', streamText: oldLong, site: 'snapshot_stream' },
  { name: 'utf8_published_2049', snapshots: [{ text: '中'.repeat(683) }, { text: revised, complete: true }], text: revised, revisions: 1, streamingError: 'NON_MONOTONIC_NATIVE_RESPONSE', streamText: '中'.repeat(683), site: 'snapshot_stream' },
  { name: 'validated_call_replaced', tools: true, snapshots: [{ text: tool('old') }, { text: tool('new'), complete: true }], text: '\n', revisions: 1, callValue: 'new', streamCallValue: 'old', streamingError: 'NON_MONOTONIC_NATIVE_RESPONSE', streamText: '\n', site: 'snapshot_stream' },
];
let current, attempts = 0, passed = 0;
const openTurn = () => { attempts++; return { cancel() {}, events: { async *[Symbol.asyncIterator]() {
  yield { type: 'headers', httpStatus: 200 };
  for (const s of current.snapshots) yield { type: 'frame', bytes: frame(s) };
  yield { type: 'end', httpStatus: 200, grpcStatus: 0 };
} } }; };
const app = createGateway({ store: state, accounts, openTurn, allowFailover: false, allowQuotaFailover: false, allowEmptyResponseFailover: false, allowAutomaticRecovery: false });
function parsed(raw, route, stream) {
  if (!stream) { const b = JSON.parse(raw); return { text: route === 'chat' ? b.choices?.[0]?.message?.content : (b.output ?? []).filter(i => i.type === 'message').flatMap(i => i.content).map(i => i.text).join(''),
    calls: route === 'chat' ? b.choices?.[0]?.message?.tool_calls ?? [] : (b.output ?? []).filter(i => i.type === 'function_call'), incomplete: b.status === 'incomplete', code: b.error?.code }; }
  const events = raw.split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
  return { events, text: route === 'chat' ? events.flatMap(e => e.choices ?? []).map(c => c.delta?.content ?? '').join('') : events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join(''),
    calls: route === 'chat' ? events.flatMap(e => e.choices ?? []).flatMap(c => c.delta?.tool_calls ?? []) : events.filter(e => e.type === 'response.output_item.added' && e.item.type === 'function_call').map(e => e.item),
    incomplete: events.some(e => e.incomplete || e.type === 'response.incomplete'), code: events.find(e => e.error)?.error?.code ?? events.find(e => e.incomplete_details)?.incomplete_details?.code ?? events.at(-1)?.response?.error?.code };
}
class Sink extends EventEmitter {
  chunks=[]; destroyed=false; writableEnded=false;
  writeHead() { this.headersSent=true; }
  write(s) { this.chunks.push(String(s)); return true; }
  end(s) { if(s)this.write(s);this.writableEnded=true; }
  text() { return this.chunks.join(''); }
}
const timer=setTimeout(()=>{console.error('BOUNDARY_PROBE_TIMEOUT');process.exit(2);},30000);
try {
  const base=await app.listen({host:'127.0.0.1',port:0});
  for(const spec of cases) for(const route of ['chat','responses']) for(const stream of [false,true]) {
    current=spec;const before=attempts;
    const body={model:'gemini-argon',stream,...(route==='chat'?{messages:[{role:'user',content:'synthetic revision boundary'}],...(spec.tools?{tools}:{})}:{input:'synthetic revision boundary',...(spec.tools?{tools:tools.map(t=>({type:'function',...t.function}))}:{})})};
    const res=await fetch(base+'/v1/'+(route==='chat'?'chat/completions':'responses'),{method:'POST',headers:{Authorization:'Bearer '+key.key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(3000)});
    const out=parsed(await res.text(),route,stream),expectedError=stream&&spec.streamingError||spec.error;
    assert.equal(res.status,200,spec.name);assert.equal(attempts-before,1,'same attempt, no retry or splicing');
    assert.equal(out.text,stream&&spec.streamText!==undefined?spec.streamText:spec.text,`${spec.name}/${route}/${stream}`);
    assert.equal(out.incomplete,!!expectedError,spec.name);assert.equal(out.code??null,expectedError??null,spec.name);
    if(!expectedError)assert.equal(app.overview().requests[0].nativeResponseRevisions,spec.name==='anonymous_append'?undefined:spec.revisions);
    if(expectedError&&spec.site){const e=app.overview().requests[0].nativeEvidence;assert.equal(e.nonMonotonicSite,spec.site);assert.equal(e.publishedBytes,stream&&spec.streamingError?Buffer.byteLength(spec.streamText):0);}
    if(spec.tools){assert.equal(out.calls.length,1);const args=route==='chat'?out.calls[0].function.arguments:stream?out.events.filter(e=>e.type==='response.function_call_arguments.delta').map(e=>e.delta).join(''):out.calls[0].arguments;assert.equal(JSON.parse(args).value,stream?spec.streamCallValue:spec.callValue);}
    passed++;
  }
  // Sink reset: atomic, only explicitly same identity, and no committed output.
  for(const route of ['chat','responses']) {
    const sink=new Sink(),d=createResponseDelivery(sink,{route,stream:true,model:'gemini-argon'});
    await d.accept({content:short});assert.deepEqual(d.outputCommitState(),{publishedBytes:0,toolCallCount:0});
    await assert.rejects(d.accept({reset:true}),e=>e.nativeEvidence?.nonMonotonicSite==='delivery_reset');
    await d.accept({reset:true,sameResponseIdentity:true});assert.equal(d.hasContent,false);
    await d.accept({content:newLong});
    await assert.rejects(d.accept({reset:true,sameResponseIdentity:true}),e=>e.nativeEvidence?.publishedBytes===2600);
    assert.equal(d.publishedBytes,2600);passed++;
    // Final reconciliation can replace held text only with matching verified identity.
    for(const verified of [false,true]) {
      const s=new Sink(),delivery=createResponseDelivery(s,{route,stream:true,model:'gemini-argon'}),identity={id:'chatcmpl-fixed',model:'gemini-argon'};
      await delivery.accept({content:short,response:identity});const result={...identity,content:revised,calls:[],nativeEvidence:{nativeResponseIdentityVerified:verified}};
      if(verified){await delivery.complete(result);assert.equal(parsed(s.text(),route,true).text,revised);}else await assert.rejects(delivery.complete(result),e=>e.nativeEvidence?.nonMonotonicSite==='delivery_final');
      passed++;
    }
  }
  // Refused reset must not clear the provider's previous partial before the sink accepts.
  current=cases[0];const provider=new NativeDirectProvider(accounts,{openTurn});
  await assert.rejects(provider.runTurn('synthetic',{model:'gemini-argon',messages:[{role:'user',content:'test'}]},event=>{if(event.reset)throw Object.assign(Error('synthetic sink rejection'),{code:'NATIVE_STREAM_FAILED'});},{incrementalOutput:true,outputMode:'stream',getOutputCommitState:()=>({publishedBytes:0,toolCallCount:0})}),e=>e.partialResult?.content===short);passed++;
  // Unknown commit feedback must remain conservative, never authorize stream rewrites.
  for(const callback of [undefined,()=>({publishedBytes:-1,toolCallCount:0}),()=>{throw Error('unavailable');}]) {
    current=cases[0];await assert.rejects(provider.runTurn('synthetic',{model:'gemini-argon',messages:[{role:'user',content:'test'}]},()=>{}, {incrementalOutput:true,outputMode:'stream',...(callback?{getOutputCommitState:callback}:{})}),e=>e.code==='NON_MONOTONIC_NATIVE_RESPONSE'&&e.nativeEvidence?.nonMonotonicSite==='snapshot_stream');passed++;
  }
  console.log(JSON.stringify({passed:true,cases:passed,realUpstreamRequests:0,callerToolExecutions:0,oneAttemptPerHttp:true,identityAndCommittedOutputGuardsPreserved:true}));
} finally {clearTimeout(timer);app.server.closeAllConnections?.();await app.close();fs.rmSync(directory,{recursive:true,force:true});}
