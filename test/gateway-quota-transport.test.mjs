import test from "node:test";
import assert from "node:assert/strict";
import {EventEmitter} from "node:events";
import {fetchGoogleUsageInfo,QUOTA_ORIGIN,QUOTA_RPC} from "../src/gateway/quota-transport.mjs";
import {frameGrpcMessage} from "../native-wire/robin-current.mjs";
function transport(emit) {
  const state={connects:0,requests:0,cancelled:0};
  const request=new EventEmitter();request.rstCode=0;request.close=()=>state.cancelled++;
  request.end=bytes=>{assert.deepEqual(bytes,frameGrpcMessage(Buffer.alloc(0)));queueMicrotask(()=>emit(request));};
  const client=new EventEmitter();client.destroy=()=>{};client.request=headers=>{state.requests++;assert.equal(headers[":path"],QUOTA_RPC);assert.equal(headers.authorization,"Bearer synthetic-token");return request;};
  return {state,connect:origin=>{state.connects++;assert.equal(origin,QUOTA_ORIGIN);return client;}};
}
test("read-only usage request accepts exactly one complete grpc-success payload",async()=>{
  const t=transport(r=>{r.emit("response",{":status":200});r.emit("data",frameGrpcMessage(Buffer.from([8,1])));r.emit("trailers",{"grpc-status":"0"});r.emit("end");});
  const data=await fetchGoogleUsageInfo("synthetic-token",{connect:t.connect});assert.deepEqual(data.payload,Buffer.from([8,1]));assert.equal(data.grpcStatus,0);assert.equal(t.state.requests,1);
});
test("missing grpc terminal and peer reset do not become quota success",async()=>{
  for(const reset of [false,true]){const t=transport(r=>{r.emit("response",{":status":200});r.emit("data",frameGrpcMessage(Buffer.alloc(0)));if(reset){r.rstCode=8;r.emit("trailers",{"grpc-status":"0"});}r.emit("end");});await assert.rejects(fetchGoogleUsageInfo("synthetic-token",{connect:t.connect}),e=>e.code===(reset?"QUOTA_STREAM_RESET":"QUOTA_INCOMPLETE_RESPONSE"));assert.equal(t.state.requests,1);}
});
test("auth, rate and prerequisite rejections are safe, bounded and never retried",async()=>{
  for(const [headers,code]of [[{":status":429},"QUOTA_RATE_LIMITED"],[{":status":403},"QUOTA_AUTH_REJECTED"],[{":status":200,"grpc-status":"9"},"QUOTA_PRECONDITION_REQUIRED"]]){const t=transport(r=>r.emit("response",headers));await assert.rejects(fetchGoogleUsageInfo("synthetic-token",{connect:t.connect}),e=>e.code===code&&!e.message.includes("synthetic-token"));assert.equal(t.state.connects,1);assert.equal(t.state.requests,1);}
});
test("malformed, oversized and multiple unary payloads fail closed",async()=>{
  for(const body of [Buffer.from([1,0,0,0,0]),Buffer.alloc(1024*1024+1),Buffer.concat([frameGrpcMessage(Buffer.alloc(0)),frameGrpcMessage(Buffer.alloc(0))])]){const t=transport(r=>{r.emit("response",{":status":200});r.emit("data",body);r.emit("trailers",{"grpc-status":"0"});r.emit("end");});await assert.rejects(fetchGoogleUsageInfo("synthetic-token",{connect:t.connect}),e=>/^QUOTA_/.test(e.code));}
});
test("timeout/cancellation and invalid credentials stop without retries",async()=>{
  const t=transport(()=>{});await assert.rejects(fetchGoogleUsageInfo("synthetic-token",{connect:t.connect,timeoutMs:10}),e=>e.code==="QUOTA_TIMEOUT");assert.equal(t.state.requests,1);
  const controller=new AbortController();controller.abort();await assert.rejects(fetchGoogleUsageInfo("synthetic-token",{connect:t.connect,signal:controller.signal}),e=>e.code==="QUOTA_CANCELLED");assert.equal(t.state.requests,1);
  await assert.rejects(fetchGoogleUsageInfo("",{connect:t.connect}),e=>e.code==="QUOTA_CREDENTIAL_REQUIRED");
});
