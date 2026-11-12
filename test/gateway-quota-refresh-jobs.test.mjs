import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './gateway-fixture.mjs';
import { QuotaRefreshJobs } from '../src/gateway/quota-refresh-jobs.mjs';
import { safeQuota, decodeUsageInfo } from '../src/gateway/quota.mjs';
import { lengthDelimited as m, varintField as v } from '../native-wire/protobuf.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i=0;i<400;i++) { if (fn()) return; await sleep(5); } assert.fail('Condition did not become true'); }
const float = (number, value) => { const b=Buffer.alloc(4);b.writeFloatLE(value);return Buffer.concat([Buffer.from([number*8+5]),b]); };
const payload = (rows=[['Current usage',.25],['Weekly limit',.5]]) => Buffer.concat(rows.map(([label,percent],i)=>m(3,Buffer.concat([v(1,i+1),m(2,Buffer.concat([...(percent===null?[]:[float(2,percent)]),m(3,Buffer.from(label))]))]))));
const savedAt='2025-01-01T00:00:00.000Z';
const quota = () => safeQuota({source:'official',provider:'google-robin',status:'ok',updatedAt:savedAt,usageUpdatedAt:savedAt,...decodeUsageInfo(payload())});
const start = async (f, body={}) => { const response=await f.admin('accounts/quota-refresh',{method:'POST',body});assert.equal(response.status,202);return response.json(); };
async function finish(f,id) { let job;for(let i=0;i<400;i++){const r=await f.admin('accounts/quota-refresh/'+id);assert.equal(r.status,200);job=(await r.json()).job;if(job.status!=='running')return job;await sleep(5);}assert.fail('Job did not settle'); }

test('one authenticated batch really fetches every eligible account with at most two workers; polling is passive',async t=>{
 let calls=0,inFlight=0,peak=0;
 const f=await fixture({accountCount:6,quotaFetch:async()=>{calls++;peak=Math.max(peak,++inFlight);await sleep(20);inFlight--;return{payload:payload(),observedAt:'2025-01-02T00:00:00.000Z'};}});t.after(f.close);
 const before=JSON.stringify(f.store.data.accounts.map(a=>({id:a.id,enabled:a.enabled,providerStates:a.providerStates}))),profile=JSON.stringify(f.store.data.profile);
 await f.admin('overview');assert.equal(calls,0);const first=await start(f,{trigger:'auto'});assert.equal(first.job.trigger,'auto');assert.equal(first.job.total,6);
 const row=await finish(f,first.job.id);assert.equal(row.status,'completed');assert.equal(row.completed,6);assert.equal(row.updated,6);assert.equal(row.failed,0);assert.equal(row.missing,0);assert.equal(row.skipped,0);assert.equal(calls,6);assert.equal(peak,2);
 assert.ok(row.results.every(r=>r.status==='updated'&&r.quota.usageRows[0].providerPercent===25));
 const count=calls;await f.admin('accounts/quota-refresh/'+row.id);await f.admin('overview');assert.equal(calls,count);
 assert.equal(f.seen.length,0);assert.equal(JSON.stringify(f.store.data.profile),profile);assert.equal(JSON.stringify(f.store.data.accounts.map(a=>({id:a.id,enabled:a.enabled,providerStates:a.providerStates}))),before);
});

test('repeated manual/auto submissions attach to the same active batch without duplicate lookups',async t=>{
 let calls=0,release;const waiting=new Promise(resolve=>{release=resolve;});
 const f=await fixture({accountCount:6,quotaFetch:async()=>{calls++;await waiting;return{payload:payload()};}});t.after(f.close);
 const first=await start(f);await until(()=>calls===2);const duplicate=await start(f,{trigger:'auto'});assert.equal(duplicate.reused,true);assert.equal(duplicate.job.id,first.job.id);assert.equal(duplicate.job.trigger,'manual');assert.equal(calls,2);
 assert.equal(duplicate.job.results.filter(r=>r.status==='running').length,2);assert.equal(duplicate.job.completed,0);
 release();const done=await finish(f,first.job.id);assert.equal(done.updated,6);assert.equal(calls,6);assert.equal(f.seen.length,0);
});

test('partial failure, missing data and disabled/login skips preserve caches; generation does not block refresh',async t=>{
 let calls=0;const f=await fixture({accountCount:6,quotaFetch:async token=>{calls++;if(token==='synthetic-acc-1')return{payload:Buffer.alloc(0)};if(token==='synthetic-acc-2')throw Object.assign(Error('SYNTHETIC_SECRET_MUST_NOT_LEAK'),{code:'QUOTA_TIMEOUT',status:504});return{payload:payload()};}});t.after(f.close);
 f.app.accounts.getValidAccessToken=async id=>'synthetic-'+id;
 for(const account of f.store.data.accounts)account.quota=quota();f.store.data.accounts[3].enabled=false;f.store.data.accounts[4].refreshToken='';f.app.pool.stats('acc-5').inFlight=1;f.store.save();
 const first=await start(f);const done=await finish(f,first.job.id);
 assert.deepEqual([done.completed,done.updated,done.missing,done.failed,done.skipped],[6,2,1,1,2]);assert.equal(calls,4);
 const byId=new Map(done.results.map(r=>[r.accountId,r]));assert.equal(byId.get('acc-3').reason,'ACCOUNT_DISABLED');assert.equal(byId.get('acc-4').reason,'ACCOUNT_LOGIN_REQUIRED');assert.equal(byId.get('acc-5').status,'updated');assert.equal(byId.get('acc-2').reason,'QUOTA_TIMEOUT');
 assert.equal(f.app.pool.stats('acc-5').inFlight,1);
 assert.doesNotMatch(JSON.stringify(done),/SYNTHETIC_SECRET_MUST_NOT_LEAK|synthetic-access|refreshToken/);
 for(const id of[1,2]){const q=f.store.data.accounts[id].quota;assert.equal(q.usageRows[0].providerPercent,25);assert.equal(q.updatedAt,savedAt);assert.equal(q.usageUpdatedAt,savedAt);}
 assert.equal(f.store.data.accounts[1].quota.status,'missing');assert.equal(f.store.data.accounts[2].quota.status,'error');assert.equal(f.store.data.accounts[3].enabled,false);assert.equal(f.seen.length,0);
});

test('batch status/start keep cookie/Origin/CSRF boundaries and reject unsupported inputs',async t=>{
 let calls=0;const f=await fixture({quotaFetch:async()=>{calls++;return{payload:payload()};}});t.after(f.close);
 assert.equal((await f.request('/admin/api/accounts/quota-refresh',{method:'POST',body:{}})).status,403);
 assert.equal((await f.request('/admin/api/accounts/quota-refresh',{method:'POST',body:{},headers:{Origin:f.base}})).status,401);
 assert.equal((await f.api('/admin/api/accounts/quota-refresh',{method:'POST',body:{},headers:{Origin:f.base}})).status,401);
 const noCsrf=await f.request('/admin/api/accounts/quota-refresh',{method:'POST',body:{},headers:{Cookie:f.cookie,Origin:f.base}});assert.equal(noCsrf.status,403);
 assert.equal((await f.admin('accounts/quota-refresh',{method:'POST',body:{accountIds:['acc-0']}})).status,400);
 assert.equal((await f.admin('accounts/quota-refresh',{method:'POST',body:{trigger:'background-forever'}})).status,400);
 const unknown='quota_refresh_00000000-0000-0000-0000-000000000000';assert.equal((await f.request('/admin/api/accounts/quota-refresh/'+unknown)).status,401);
 const missing=await f.admin('accounts/quota-refresh/'+unknown);assert.equal(missing.status,404);assert.equal((await missing.json()).error.code,'QUOTA_REFRESH_JOB_NOT_FOUND');assert.equal(calls,0);
});

test('recent attempts are skipped honestly and do not change timestamps or claim fresh updates',async t=>{
 let calls=0;const f=await fixture({quotaFetch:async()=>{calls++;return{payload:payload(),observedAt:savedAt};}});t.after(f.close);
 const one=await start(f);await finish(f,one.job.id);const before=JSON.stringify(f.store.data.accounts.map(a=>a.quota));
 const two=await start(f);const done=await finish(f,two.job.id);assert.equal(done.updated,0);assert.equal(done.skipped,2);assert.ok(done.results.every(r=>r.reason==='QUOTA_REFRESH_THROTTLED'));assert.equal(calls,2);assert.equal(JSON.stringify(f.store.data.accounts.map(a=>a.quota)),before);
});

test('an active individual quota lookup is coalesced rather than duplicated by the batch',async t=>{
 let calls=0,release;const waiting=new Promise(resolve=>{release=resolve;});const f=await fixture({quotaFetch:async()=>{calls++;await waiting;return{payload:payload()};}});t.after(f.close);
 const individual=f.app.accounts.refreshQuota('acc-0');await until(()=>calls===1);const batch=await start(f);await until(()=>calls===2);release();await individual;const done=await finish(f,batch.job.id);assert.equal(done.updated,2);assert.equal(calls,2);
});

test('quota labels without any numeric usage are missing, not an invented updated0 percent',async t=>{
 const f=await fixture({quotaFetch:async()=>({payload:payload([['Current usage',null],['Weekly limit',null]])})});t.after(f.close);
 const first=await start(f);const done=await finish(f,first.job.id);assert.equal(done.updated,0);assert.equal(done.missing,2);assert.ok(done.results.every(r=>r.quota.usageRows.every(row=>row.providerPercent===null)));
});

test('individual quota cancellation prevents late results from replacing the saved snapshot',async t=>{
 let called=0,release;const waiting=new Promise(resolve=>{release=resolve;});const f=await fixture({quotaFetch:async()=>{called++;await waiting;return{payload:payload([['Current usage',.75]]),observedAt:'2026-01-01T00:00:00.000Z'};}});t.after(f.close);
 f.store.data.accounts[0].quota=quota();f.store.save();const original=JSON.stringify(f.store.data.accounts[0].quota),controller=new AbortController();
 const task=f.app.accounts.refreshQuota('acc-0',{signal:controller.signal});await until(()=>called===1);controller.abort();await assert.rejects(task,{code:'QUOTA_CANCELLED',status:499});release();await sleep(10);
 assert.equal(JSON.stringify(f.store.data.accounts[0].quota),original);assert.equal(f.app.accounts.quotaPending.size,0);assert.equal(f.app.accounts.quotaControllers.size,0);
});

test('closing quota operations while credentials are pending prevents a later Google lookup',async t=>{
 let called=0,release;const waiting=new Promise(resolve=>{release=resolve;});const f=await fixture({quotaFetch:async()=>{called++;return{payload:payload()};}});t.after(f.close);
 f.app.accounts.getValidAccessToken=async()=>{await waiting;return'synthetic-late-token';};
 const task=f.app.accounts.refreshQuota('acc-0');await sleep(5);f.app.accounts.close();await assert.rejects(task,{code:'QUOTA_CANCELLED'});release();await sleep(10);assert.equal(called,0);assert.equal(f.store.data.accounts[0].quota,undefined);
});

const fakeAccounts=(count=3,refreshQuota=async()=>quota())=>({list:()=>Array.from({length:count},(_,i)=>({id:'synthetic-'+i,enabled:true,authenticationStatus:'signed_in'})),refreshQuota});
test('overall deadline and shutdown settle every entry even if an injected lookup ignores cancellation',async()=>{
 let calls=0;const accounts=fakeAccounts(4,async()=>{calls++;return new Promise(()=>{});});const jobs=new QuotaRefreshJobs(accounts,{timeoutMs:25});
 const first=jobs.start();await until(()=>jobs.get(first.job.id).status!=='running');const done=jobs.get(first.job.id);assert.equal(done.status,'cancelled');assert.equal(done.reason,'QUOTA_TIMEOUT');assert.equal(done.failed,4);assert.equal(done.completed,4);assert.equal(calls,2);assert.ok(done.results.every(r=>r.reason==='QUOTA_TIMEOUT'));await jobs.close();
 const closing=new QuotaRefreshJobs(fakeAccounts(2,async()=>new Promise(()=>{})));const pending=closing.start();await closing.close();const cancelled=closing.get(pending.job.id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.completed,2);assert.equal(cancelled.reason,'QUOTA_CANCELLED');assert.throws(()=>closing.start(),{code:'QUOTA_CANCELLED'});
});

test('job retention is bounded without evicting completed jobs merely because they are polled',async()=>{
 let now=1000;const jobs=new QuotaRefreshJobs(fakeAccounts(1),{maxJobs:2,retentionMs:1000,now:()=>now});
 const a=jobs.start();await jobs.jobs.get(a.job.id).promise;const b=jobs.start();await jobs.jobs.get(b.job.id).promise;assert.equal(jobs.jobs.size,2);
 assert.equal(jobs.get(a.job.id).status,'completed');assert.equal(jobs.get(b.job.id).status,'completed');assert.equal(jobs.jobs.size,2);
 const c=jobs.start();await jobs.jobs.get(c.job.id).promise;assert.equal(jobs.jobs.size,2);assert.throws(()=>jobs.get(a.job.id),{code:'QUOTA_REFRESH_JOB_NOT_FOUND'});assert.equal(jobs.get(b.job.id).status,'completed');
 now+=1001;assert.throws(()=>jobs.get(c.job.id),{code:'QUOTA_REFRESH_JOB_NOT_FOUND'});await jobs.close();
});

test('individual quota route refreshes during inference without changing its reservation',async t=>{
 let calls=0;const f=await fixture({quotaFetch:async()=>{calls++;return{payload:payload()};}});t.after(f.close);f.app.pool.stats('acc-0').inFlight=1;
 const r=await f.admin('accounts/acc-0/quota',{method:'POST',body:{}});assert.equal(r.status,200);assert.equal((await r.json()).quota.usageRows[0].providerPercent,25);assert.equal(calls,1);assert.equal(f.app.pool.stats('acc-0').inFlight,1);
});

test('usage refresh never overwrites newer passive budget observations received while it was pending',async()=>{
 for(const outcome of['data','missing','error']){
  let called=false,release;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture({quotaFetch:async()=>{called=true;await gate;if(outcome==='error')throw Object.assign(Error('Synthetic failure'),{code:'QUOTA_TIMEOUT',status:504});return{payload:outcome==='missing'?Buffer.alloc(0):payload(),observedAt:'2026-01-04T00:00:00.000Z'};}});
  try{
   const account=f.store.data.accounts[0];account.quota=quota();f.store.save();const task=f.app.accounts.refreshQuota('acc-0');await until(()=>called);
   account.quota=safeQuota({...account.quota,updatedAt:'2026-01-03T00:00:00.000Z',budgetsUpdatedAt:'2026-01-03T00:00:00.000Z',budgets:[{sourcePath:'clientGenerateResponse.20.1[0]',available:7,max:10,providerPercent:30,unit:1,refillAt:null}]});f.store.save();
   release();if(outcome==='error')await assert.rejects(task,{code:'QUOTA_TIMEOUT'});else await task;
   assert.equal(account.quota.budgets[0].available,7);assert.equal(account.quota.budgetsUpdatedAt,'2026-01-03T00:00:00.000Z');
   assert.equal(account.quota.usageRows[0].providerPercent,25);
  }finally{await f.close();}
 }
});

test('an older lookup observation preserves newer usage and is reported as skipped instead of updated',async t=>{
 let called=false,release;const gate=new Promise(resolve=>{release=resolve;});const f=await fixture({accountCount:1,quotaFetch:async()=>{called=true;await gate;return{payload:payload(),observedAt:'2026-01-02T00:00:00.000Z'};}});t.after(f.close);
 f.store.data.accounts[0].quota=quota();f.store.save();const job=await start(f);await until(()=>called);
 const newer=safeQuota({source:'official',provider:'google-robin',status:'ok',updatedAt:'2026-01-03T00:00:00.000Z',usageUpdatedAt:'2026-01-03T00:00:00.000Z',...decodeUsageInfo(payload([['Current usage',.75]]))});
 f.store.data.accounts[0].quota=newer;f.store.save();release();const done=await finish(f,job.job.id);
 assert.equal(done.updated,0);assert.equal(done.skipped,1);assert.equal(done.results[0].reason,'QUOTA_SNAPSHOT_NEWER');
 const saved=f.store.data.accounts[0].quota;assert.equal(saved.usageRows[0].providerPercent,75);assert.equal(saved.usageUpdatedAt,newer.usageUpdatedAt);assert.equal(saved.updatedAt,newer.updatedAt);assert.equal(Object.hasOwn(saved,'refreshSkippedReason'),false);
});

test('an invalid lookup observation timestamp fails without replacing cached usage',async t=>{
 const f=await fixture({accountCount:1,quotaFetch:async()=>({payload:payload([['Current usage',.75]]),observedAt:'not-a-timestamp'})});t.after(f.close);
 f.store.data.accounts[0].quota=quota();f.store.save();const job=await start(f);const done=await finish(f,job.job.id);
 assert.equal(done.failed,1);assert.equal(done.updated,0);assert.equal(done.results[0].reason,'QUOTA_INVALID_RESPONSE');
 assert.equal(f.store.data.accounts[0].quota.usageRows[0].providerPercent,25);assert.equal(f.store.data.accounts[0].quota.updatedAt,savedAt);
});

test('a minimal injected account reader does not break unrelated authentication/listener operations',async()=>{
 const jobs=new QuotaRefreshJobs({list:()=>[]});assert.equal(jobs.summary().running,false);
 assert.throws(()=>jobs.start(),{code:'QUOTA_REFRESH_UNAVAILABLE',status:503});assert.equal(jobs.jobs.size,0);await jobs.close();
});
