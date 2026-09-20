import { demoContext } from "../../app/demo";
import { mkdirSync, writeFileSync } from "node:fs";
const base="http://127.0.0.1:3018";
const output = new URL("../../output/qwen-local-test/", import.meta.url);
mkdirSync(output, { recursive: true });
const results:any[]=[];
const direct=await fetch("http://127.0.0.1:8018/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"qwen3.5-0.8b-q8",messages:[{role:"user",content:"2+2等于多少？只输出数字。"}],temperature:0,max_tokens:32,chat_template_kwargs:{enable_thinking:false}}),signal:AbortSignal.timeout(120000)});
const chat:any=await direct.json();
results.push({test:"direct_local_chat",httpStatus:direct.status,model:chat.model,content:chat.choices?.[0]?.message?.content,usage:chat.usage});
for(const variant of ["normal","risk","missing-core"]){
 const context:any=demoContext();context.symbol="SYNTHETIC-X";context.pack.subject={code:"SYNTHETIC-X",stock_name:"本地模型测试合成样本"};
 context.provenance={source:"synthetic_local_inference_test_not_market_data"};
 if(variant==="risk"){
   context.pack.blocks.news.items.content.value="合成测试情境：公司披露严重亏损和重大债务违约风险。";
   context.pack.blocks.technical.items.trend_result.value={signal_score:10,trend_status:"明显下行（合成测试）"};
 }
 if(variant==="missing-core")context.pack.blocks.technical={status:"missing",items:{}};
 const started=performance.now();
 const response=await fetch(base+"/v1/decisions",{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify({symbol:context.symbol,position:variant==="risk"?"long":"flat",mode:"live",backend:"local",localEngine:"logprobs",context,waitSeconds:25}),signal:AbortSignal.timeout(35000)});
 let result:any=await response.json();
 for(let i=0;i<90 && !["done","failed"].includes(result.state) && result.links;i++){
   await Bun.sleep(2000);result=await (await fetch(base+result.links.self)).json();
 }
 if(result.links && result.decision){
   const evidence=await (await fetch(base+result.links.evidence)).json();
   writeFileSync(new URL(`evidence-${variant}.json`,output),JSON.stringify(evidence,null,2));
 }
 results.push({test:variant,httpStatus:response.status,state:result.state,modelSource:result.decision?.model_source,status:result.decision?.status,action:result.decision?.final_action,modelAction:result.decision?.model_action,probabilities:result.decision?.action_probabilities,inference:result.decision?.inference,latencyMs:result.decision?.latency_ms,totalMs:Math.round(performance.now()-started),reasons:result.decision?.reason_codes,error:result.error});
 console.log(JSON.stringify(results.at(-1)));
}
writeFileSync(new URL("results.json",output),JSON.stringify({checkedAt:new Date().toISOString(),results},null,2));
console.log(JSON.stringify(results[0]));
const failures = results.filter(r => {
 if (r.test === "direct_local_chat") return r.httpStatus !== 200 || r.content?.trim() !== "4";
 if (r.httpStatus >= 400 || r.state !== "done" || r.modelSource !== "local") return true;
 if (r.test === "missing-core") return r.status !== "skipped" || r.action !== "hold" || r.latencyMs !== null || !r.reasons?.includes("UNUSABLE_TECHNICAL");
 const scores = Object.values(r.probabilities ?? {}) as number[];
 return r.status !== "accepted" || r.inference?.probability_method !== "label_logprobs" || scores.length !== 3 || scores.some(p => !Number.isFinite(p) || p < 0 || p > 1) || Math.abs(scores.reduce((a,b) => a+b,0)-1) > 1e-6;
});
if (failures.length) { console.error("Smoke test failed:", failures.map(r => r.test)); process.exitCode = 1; }
