import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsStore, readiness } from "./settings";
import { localURL } from "./backends";
import { classifyWithBackend, inferenceMetadata, probeBackend } from "./model";
import { bridge } from "./python";
import { demoContext, demoResponse } from "./demo";

function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"jev-backend-"));
  const store=new SettingsStore(dir);
  return {dir,store,close:()=>rmSync(dir,{recursive:true,force:true})};
}
const request={model:"jev-latest",state:"stock context",questions:{action:{type:"choice",instructions:"decide",criteria:{buy:"increase",sell:"decrease",hold:"wait"}}}};

test("local settings do not require or expose a cloud key; URL validation rejects credential leaks",()=>{
 const f=fixture();
 try {
  f.store.save({backend:"local",localEngine:"generated",localBaseUrl:"http://127.0.0.1:8080/v1/",localApiKey:"local-secret",apiKey:"cloud-secret",modelTimeoutSeconds:180});
  expect(f.store.read().localBaseUrl).toBe("http://127.0.0.1:8080");
  expect(readiness(f.store).checks.some(c=>c.id==="key")).toBe(false);
  expect(JSON.stringify(f.store.public())).not.toContain("secret");
  for(const url of ["https://example.com", "http://cloud-secret@localhost:8080", "http://127.0.0.1:8080/?key=secret", "file:///tmp/model", "http://localhost:8080/chat/completions"]) expect(()=>localURL(url)).toThrow();
  expect(()=>f.store.save({backend:"unknown"})).toThrow();
  expect(()=>f.store.save({modelTimeoutSeconds:301})).toThrow();
  f.store.save({localApiKey:""}); expect(f.store.read().localApiKey).toBe("local-secret");
 }finally{f.close();}
});

for(const backend of ["generated","logprobs"] as const) test(`${backend}: real HTTP, raw response, provenance, bridge and audit`,async()=>{
 const f=fixture(); let calls=0;
 const raw={...demoResponse(),model:backend==="generated"?"localjev-0.2":"jev-latest"};
 const upstream=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
  if(new URL(req.url).pathname!=="/v1/systemone") return Response.json({status:backend==="generated"?"ready":"ok",upstream_model:"local-weight"});
  calls++; expect(req.headers.get("authorization")).toBe("Bearer local-secret");
  const payload:any=await req.json(); expect(payload.questions.action.type).toBe("choice");
  expect(Object.keys(payload.questions.action.criteria).sort()).toEqual(["buy","hold","sell"]);
  return Response.json(raw,{headers:backend==="logprobs"?{"x-openjev-model":"Qwen/test-model"}:{}});
 }});
 try{
  f.store.save({backend:"local",localEngine:backend,apiKey:"cloud-key-must-not-be-sent",localApiKey:"local-secret",localBaseUrl:`http://127.0.0.1:${upstream.port}`,localModelId:"declared-weight",localRevision:"pinned-rev",modelTimeoutSeconds:5});
  const settings=f.store.read(); expect((await probeBackend(settings)).reachable).toBe(true);
  const result=await classifyWithBackend(request,settings);
  expect(result.raw).toEqual(raw);expect(calls).toBe(1);
  expect(result.inference.probability_method).toBe(backend==="generated"?"generated_probabilities":"label_logprobs");
  expect(result.inference.reported_model).toBe(backend==="logprobs"?"Qwen/test-model":null);
  const signal=await bridge({operation:"complete",context:demoContext(),config:{horizon:"5 days",execution_assumption:"next_session_open",cost_assumption:"0.3%",position:{state:"flat"}},model:"jev-latest",response:result.raw,inference:result.inference,latency_ms:123,demo:false,job_id:"backend-check",database:join(f.dir,"audit.db")});
  expect(signal.model_source).toBe("local"); expect(signal.inference.declared_revision).toBe("pinned-rev");
  expect(signal.final_action).toBe("hold"); expect(signal.status).toBe("accepted");
 }finally{upstream.stop(true);f.close();}
});

test("local failure and redirect never retry or fall back to cloud",async()=>{
 const f=fixture();let calls=0,targetCalls=0;
 const target=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){targetCalls++;return Response.json(demoResponse());}});
 const upstream=Bun.serve({hostname:"127.0.0.1",port:0,fetch(){calls++;return Response.redirect(`http://127.0.0.1:${target.port}/v1/systemone`,307);}});
 try{
  f.store.save({backend:"local",localEngine:"generated",localBaseUrl:`http://127.0.0.1:${upstream.port}`,apiKey:"cloud-key"});
  await expect(classifyWithBackend(request,f.store.read())).rejects.toThrow();
  expect(calls).toBe(1);expect(targetCalls).toBe(0);
  upstream.stop(true);
  await expect(classifyWithBackend(request,f.store.read())).rejects.toThrow();
  expect((await probeBackend(f.store.read())).reachable).toBe(false);
 }finally{upstream.stop(true);target.stop(true);f.close();}
});

test("local HTTP errors preserve status; malformed probabilities fail closed in Python",async()=>{
 const f=fixture();let calls=0;
 const mock=Object.assign(async()=>{calls++;return new Response("overloaded",{status:529});},{preconnect:fetch.preconnect});
 try{
  f.store.save({backend:"local",localEngine:"logprobs"});
  try{await classifyWithBackend(request,f.store.read(),mock);throw new Error("unexpected success");}catch(e:any){expect(e.statusCode).toBe(529);}
  expect(calls).toBe(1);
  const raw=demoResponse();raw.answers.action.probabilities.buy=2;
  const signal=await bridge({operation:"complete",context:demoContext(),config:{horizon:"5 days",execution_assumption:"next_session_open",cost_assumption:"0.3%"},model:"jev-latest",response:raw,inference:inferenceMetadata(f.store.read()),job_id:"bad-result",database:join(f.dir,"audit.db")});
  expect(signal.status).toBe("error");expect(signal.final_action).toBe("hold");expect(signal.reason_codes).toContain("INVALID_MODEL_RESPONSE");
 }finally{f.close();}
});

test("local inference timeout aborts the HTTP request",async()=>{
 const f=fixture();let calls=0;
 const upstream=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(){calls++;await Bun.sleep(1600);return Response.json(demoResponse());}});
 try{
  f.store.save({backend:"local",localEngine:"generated",modelTimeoutSeconds:1,localBaseUrl:`http://127.0.0.1:${upstream.port}`});
  await expect(classifyWithBackend(request,f.store.read())).rejects.toThrow();expect(calls).toBe(1);
 }finally{upstream.stop(true);f.close();}
});

test("backend profiles preserve separate URLs, credentials and model labels across switches",()=>{
 const f=fixture();
 try{
  f.store.save({backend:"local",localEngine:"generated",localBaseUrl:"http://127.0.0.1:8181",localApiKey:"first-key",localModelId:"first-model",modelTimeoutSeconds:200});
  f.store.save({backend:"local",localEngine:"logprobs",localBaseUrl:"http://127.0.0.1:8282",localApiKey:"second-key",localModelId:"second-model",modelTimeoutSeconds:150});
  f.store.save({backend:"jev"});
  expect(f.store.read().backend).toBe("jev");expect(f.store.read().modelTimeoutSeconds).toBe(30);
  const first=f.store.read("local", "generated"),second=f.store.read("local", "logprobs");
  expect(first.localApiKey).toBe("first-key");expect(first.localBaseUrl).toEndWith(":8181");expect(first.modelTimeoutSeconds).toBe(200);
  expect(second.localApiKey).toBe("second-key");expect(second.localModelId).toBe("second-model");
  expect(JSON.stringify(f.store.public("local", "generated"))).not.toContain("first-key");
  f.store.save({backend:"local",localEngine:"generated",localApiKey:""});expect(f.store.read().localApiKey).toBe("first-key");
 }finally{f.close();}
});

 test("legacy local settings migrate without losing engine profiles or cloud timeout",()=>{
 const f=fixture();try {
   writeFileSync(f.store.path, JSON.stringify({backend:"localjev",localBaseUrl:"http://localhost:8181",localApiKey:"legacy-key",localProfiles:{openjev_sglang:{localBaseUrl:"http://localhost:8282",localApiKey:"second-key"}}}));
   expect(f.store.read().backend).toBe("local");expect(f.store.read().localEngine).toBe("generated");
   f.store.save({backend:"jev",modelTimeoutSeconds:47});
   expect(f.store.read("local","generated").localApiKey).toBe("legacy-key");
   expect(f.store.read("local","logprobs").localApiKey).toBe("second-key");
   f.store.save({backend:"local",localEngine:"logprobs"});f.store.save({backend:"jev"});
   expect(f.store.read().modelTimeoutSeconds).toBe(47);
 }finally{f.close();}
 });
