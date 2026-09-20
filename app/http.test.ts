import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiInput, decisionResponse } from "./api";
import type { Job } from "./jobs";

test("API requires explicit position and rejects typo parameters", () => {
  expect(() => apiInput({symbol:"AAPL"})).toThrow();
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
  const proc = Bun.spawn([process.execPath,"run","app/server.ts"], {
    cwd: join(import.meta.dir,".."), env:{...process.env,PORT:"0",JEV_DATA_DIR:dir,NODE_ENV:"production"}, stdout:"pipe",stderr:"pipe",
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
  } finally { clearTimeout(timer); proc.kill(); await proc.exited; rmSync(dir,{recursive:true,force:true}); }
},20000);
