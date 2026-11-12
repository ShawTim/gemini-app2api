// Read-only Google quota RPC; no generation, quota reset, retry, redirects or model switching.
import http2 from "node:http2";
import {GrpcMessageReader,frameGrpcMessage} from "../../native-wire/robin-current.mjs";
export const QUOTA_ORIGIN = "https://robinfrontend-pa.googleapis.com";
export const QUOTA_RPC = "/$rpc/assistant.mobile.robin.RobinService/GetUsageInfo";
const failure=(code,status=502)=>Object.assign(new Error(code),{code,status});
export async function fetchGoogleUsageInfo(accessToken,{signal,timeoutMs=10000,connect=http2.connect}={}) {
  if(typeof accessToken!=="string"||!accessToken||accessToken.length>65536||/\s/.test(accessToken))throw failure("QUOTA_CREDENTIAL_REQUIRED",401);
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw failure("INVALID_QUOTA_TIMEOUT",400);
  if(signal?.aborted)throw failure("QUOTA_CANCELLED",499);
  return new Promise((resolve,reject)=>{
    let client,request,timer,settled=false,httpStatus=null,grpcStatus=null,received=0;
    const payloads=[],reader=new GrpcMessageReader({maxBytes:512*1024});
    const finish=(error,result)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener("abort",abort);
      try{request?.close();}catch{}try{client?.destroy();}catch{}
      if(error){error.quotaEvidence={httpStatus,grpcStatus};reject(error);}else resolve(result);
    };
    const abort=()=>finish(failure("QUOTA_CANCELLED",499));
    const reset=()=>{if(Number.isInteger(request?.rstCode)&&request.rstCode>0){finish(failure("QUOTA_STREAM_RESET"));return true;}return false;};
    const status=headers=>{
      if(headers[":status"]!==undefined){httpStatus=Number(headers[":status"]);if(httpStatus===429)return finish(failure("QUOTA_RATE_LIMITED",429));if(httpStatus===401||httpStatus===403)return finish(failure("QUOTA_AUTH_REJECTED",httpStatus));if(httpStatus!==200)return finish(failure("QUOTA_HTTP_REJECTED"));}
      if(headers["grpc-status"]!==undefined){const raw=String(headers["grpc-status"]);if(!/^\d{1,2}$/.test(raw)||Number(raw)>16)return finish(failure("QUOTA_INVALID_STATUS"));grpcStatus=Number(raw);if(grpcStatus===8)return finish(failure("QUOTA_RATE_LIMITED",429));if([7,16].includes(grpcStatus))return finish(failure("QUOTA_AUTH_REJECTED",403));if(grpcStatus!==0)return finish(failure(grpcStatus===9?"QUOTA_PRECONDITION_REQUIRED":"QUOTA_UPSTREAM_REJECTED"));}
    };
    signal?.addEventListener("abort",abort,{once:true});timer=setTimeout(()=>finish(failure("QUOTA_TIMEOUT",504)),timeoutMs);
    try{
      client=connect(QUOTA_ORIGIN);client.on("error",()=>finish(failure("QUOTA_CONNECTION_FAILED")));
      request=client.request({":method":"POST",":path":QUOTA_RPC,authorization:"Bearer "+accessToken,"content-type":"application/grpc",te:"trailers","grpc-timeout":timeoutMs+"m","user-agent":"gemini-app2api/1.0"});
      request.on("response",status);request.on("trailers",status);
      request.on("data",chunk=>{if(settled)return;received+=chunk.length;if(received>1024*1024)return finish(failure("QUOTA_RESPONSE_TOO_LARGE"));try{payloads.push(...reader.push(chunk));if(payloads.length>1)finish(failure("QUOTA_INVALID_RESPONSE"));}catch{finish(failure("QUOTA_INVALID_RESPONSE"));}});
      request.on("error",()=>{if(!settled&&!reset())finish(failure("QUOTA_STREAM_FAILED"));});
      request.on("close",()=>{if(!settled&&!reset())finish(failure("QUOTA_STREAM_CLOSED_EARLY"));});
      request.on("end",()=>{if(settled||reset())return;try{reader.finish();if(httpStatus!==200||grpcStatus!==0||payloads.length!==1)return finish(failure("QUOTA_INCOMPLETE_RESPONSE"));finish(null,{payload:payloads[0],observedAt:new Date().toISOString(),httpStatus,grpcStatus});}catch{finish(failure("QUOTA_INVALID_RESPONSE"));}});
      request.end(frameGrpcMessage(Buffer.alloc(0)));
    }catch{finish(failure("QUOTA_CONNECTION_FAILED"));}
  });
}
