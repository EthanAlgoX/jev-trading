import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiInput, decisionResponse } from "./api";
import { demoContext, demoResponse } from "./demo";
import { PYTHON } from "./settings";
import type { Job } from "./jobs";

test("API requires explicit position and rejects typo parameters", () => {
  expect(() => apiInput({symbol:"AAPL"})).toThrow();
  expect(() => apiInput({symbol:"AAPL",position:"flat",backend:"unknown"})).toThrow();
  expect(apiInput({symbol:"AAPL",position:"flat",backend:"localjev"}).input.backend).toBe("local");
  expect(() => apiInput({symbol:"AAPL",position:"flat",horizn:10})).toThrow();
  expect(() => apiInput({mode:"demo",position:"flat",waitSeconds:26})).toThrow();
  const {input} = apiInput({symbol:"AAPL",position:"flat"});
  expect(input.mode).toBe("live"); expect(input.horizon).toBe(5);
});

test("expired API results cannot expose an actionable stale buy", () => {
  const job = {id:"test",state:"done",result:{valid_until:"2000-01-01T00:00:00Z",final_action:"buy",status:"ok",reason_codes:[]}} as unknown as Job;
  expect(decisionResponse(job).decision.final_action).toBe("hold");
  expect(decisionResponse(job).decision.status).toBe("expired");
  expect(job.result.final_action).toBe("buy");
});

test("local HTTP service: demo, polling, idempotency, evidence and origin protection", async () => {
  const dir = mkdtempSync(join(tmpdir(),"jev-http-"));
  const aistock = join(dir,"AI-Stock"); mkdirSync(join(aistock,"src/core"),{recursive:true});
  writeFileSync(join(aistock,"src/core/pipeline.py"),"# context_only: bool = False");
  const interpreter=join(dir,"collector-test");
  const context=demoContext();
  writeFileSync(interpreter, `#!${PYTHON}
import json,sys
from pathlib import Path
c=json.loads(${JSON.stringify(JSON.stringify(context))})
c['symbol']=sys.argv[sys.argv.index('--symbol')+1]
c['pack']['subject']['code']=c['symbol']
Path(sys.argv[sys.argv.index('--output')+1]).write_text(json.dumps(c))
`,{mode:0o755});
  const calls={generated:0,logprobs:0};
  const upstreams=Object.fromEntries((["generated","logprobs"] as const).map(backend=>[backend,Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req){
    expect(req.headers.get("authorization")).toBe(`Bearer ${backend}-test-key`);
    expect(new URL(req.url).pathname).toBe("/v1/systemone");
    const body:any=await req.json();expect(JSON.parse(body.state).analysis.symbol).toBe("AAPL");
    calls[backend]++;return Response.json({...demoResponse(),model:`${backend}-model`});
  }})]));
  const proc = Bun.spawn([process.execPath,"run","app/server.ts"], {
    cwd: join(import.meta.dir,".."), env:{...process.env,PORT:"0",JEV_DATA_DIR:dir,NODE_ENV:"production",TYPESAFE_AI_API_KEY:"",TYPESAFE_API_KEY:"",JEV_BACKEND:"jev"}, stdout:"pipe",stderr:"pipe",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reader = proc.stdout.getReader();
    const base = await Promise.race([
      (async()=>{ let text=""; while(true) {const chunk=await reader.read(); if(chunk.done) throw new Error("server exited"); text+=new TextDecoder().decode(chunk.value); const match=text.match(/http:\/\/127\.0\.0\.1:\d+/); if(match) return match[0];} })(),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("startup timeout")),10000);}),
    ]); clearTimeout(timer);
    const post = (body:any,key="http-demo-test",origin?:string) => fetch(base+"/v1/decisions",{method:"POST",headers:{"content-type":"application/json","idempotency-key":key,...(origin?{origin}:{})},body:JSON.stringify(body)});
    expect((await fetch(base+"/v1/health")).status).toBe(200);
    expect((await post({mode:"demo",position:"flat"},"origin-test","https://example.com")).status).toBe(403);
    expect((await post({symbol:"AAPL"})).status).toBe(400);
    const first = await post({mode:"demo",position:"flat",waitSeconds:0});
    expect(first.status).toBe(202); const pending:any = await first.json();
    const completed = await post({mode:"demo",position:"flat"});
    expect(completed.status).toBe(200); const body:any = await completed.json();
    expect(body.request_id).toBe(pending.request_id);
    expect(body.state).toBe("done"); expect(body.decision.model_source).toBe("recorded");
    expect(body.decision.final_action).toBe("hold");
    expect((await post({mode:"demo",position:"long"})).status).toBe(409);
    const polled:any = await (await fetch(base+body.links.self)).json();
    expect(polled.request_id).toBe(body.request_id);
    const evidence:any = await (await fetch(base+body.links.evidence)).json();
    expect(evidence.context.symbol).toBe("DEMO"); expect(evidence.raw_response).toBeTruthy();
    expect((await fetch(base+"/v1/decisions/00000000-0000-0000-0000-000000000000")).status).toBe(404);
    const save=async(payload:any)=>{
      const response=await fetch(base+"/api/settings",{method:"POST",headers:{"content-type":"application/json","x-jev-request":"1"},body:JSON.stringify(payload)});
      expect(response.status).toBe(200);
    };
    for(const backend of ["generated","logprobs"] as const) await save({backend:"local",localEngine:backend,localBaseUrl:`http://127.0.0.1:${upstreams[backend]!.port}`,localApiKey:`${backend}-test-key`,aistockPath:aistock,aistockPython:interpreter});
    await save({backend:"jev"});
    const available:any=await (await fetch(base+"/v1/backends")).json();
    expect(available.default_backend).toBe("jev");
    expect(available.backends.map((b:any)=>b.backend)).toEqual(["jev","local"]);
    expect(JSON.stringify(available)).not.toContain("test-key");
    for(const backend of ["generated","logprobs"] as const){
      const result=await post({symbol:"AAPL",position:"flat",backend:"local",localEngine:backend},`request-${backend.replaceAll("_", "-")}`);
      expect(result.status).toBe(200);const decision:any=await result.json();
      expect(decision.inference_backend).toBe("local");expect(decision.decision.model_source).toBe("local");
      expect(decision.decision.inference.probability_method).toBe(backend === "generated" ? "generated_probabilities" : "label_logprobs");
      expect(decision.decision.status).toBe("accepted");expect(calls[backend]).toBe(1);
      await post({symbol:"AAPL",position:"flat",backend:"local",localEngine:backend},`request-${backend.replaceAll("_", "-")}`);
      expect(calls[backend]).toBe(1);
    }
    expect((await post({symbol:"AAPL",position:"flat",backend:"jev"},"request-generated")).status).toBe(409);
    expect((await post({symbol:"AAPL",position:"flat",backend:"jev"},"cloud-no-key")).status).toBe(503);
    expect((await (await fetch(base+"/v1/backends")).json() as any).default_backend).toBe("jev");
  } finally { clearTimeout(timer); proc.kill(); await proc.exited; for(const server of Object.values(upstreams)) server.stop(true); rmSync(dir,{recursive:true,force:true}); }
},20000);
