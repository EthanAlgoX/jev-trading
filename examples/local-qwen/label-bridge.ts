/** Local test adapter: Qwen + llama.cpp label scores -> stock-only Jev Choice API.
 * Reads real token probabilities; never generates a probability JSON or calls cloud APIs.
 */
const upstream = "http://127.0.0.1:8018";
const labels = {buy:"A",sell:"B",hold:"C"} as const;
const model = "Qwen/Qwen3.5-0.8B-Q8_0";
let busy=false;
async function post(path:string,body:any) {
 const response=await fetch(upstream+path,{method:"POST",redirect:"error",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(180000)});
 if(!response.ok)throw new Error(`UPSTREAM_HTTP_${response.status}`);
 return response.json() as Promise<any>;
}
async function tokens(content:string) {return (await post("/tokenize",{content,add_special:true,parse_special:true})).tokens as number[];}
async function classify(request:any) {
 const question=request.questions?.action;
 if(!["jev-latest","qwen3.5-0.8b-q8"].includes(request.model) || Object.keys(request.questions||{}).join()!=="action" || question?.type!=="choice" || typeof question.instructions!=="string" || typeof request.state!=="string" || Object.keys(question.criteria||{}).sort().join()!=="buy,hold,sell") throw new Error("INVALID_STOCK_CHOICE_REQUEST");
 const system=[question.instructions,"这是三分类任务。只输出一个字母，不输出解释或数字。",
  ...Object.entries(labels).map(([action,label])=>`${label}: ${action} — ${question.criteria[action]}`)].join("\n");
 const {prompt}=await post("/apply-template",{messages:[{role:"system",content:system},{role:"user",content:request.state}],add_generation_prompt:true,chat_template_kwargs:{enable_thinking:false}});
 const prefix=await tokens(prompt);
 if(prefix.length+1>8192)throw new Error("CONTEXT_LIMIT_EXCEEDED");
 const ids:Record<string,number>={};
 for(const [action,label] of Object.entries(labels)){
  const extended=await tokens(prompt+label);
  if(extended.length!==prefix.length+1 || !prefix.every((id,i)=>extended[i]===id))throw new Error("LABEL_TOKEN_BOUNDARY_MISMATCH");
  ids[action]=extended.at(-1)!;
 }
 if(new Set(Object.values(ids)).size!==3)throw new Error("LABEL_TOKEN_COLLISION");
 const raw=await post("/completion",{prompt,n_predict:1,n_probs:64,post_sampling_probs:true,temperature:1,samplers:["temperature"],top_k:0,top_p:1,min_p:0,repeat_penalty:1,grammar:'root ::= "A" | "B" | "C"',cache_prompt:true,seed:42});
 if(raw.truncated)throw new Error("CONTEXT_TRUNCATED");
 const scores=raw.completion_probabilities?.[0]?.top_probs;
 if(!Array.isArray(scores))throw new Error("MISSING_LABEL_PROBABILITIES");
 const probabilities:Record<string,number>={};
 for(const [action,id] of Object.entries(ids)){
  const matches=scores.filter((v:any)=>v.id===id);
  if(matches.length!==1 || matches[0].token!==labels[action as keyof typeof labels] || !Number.isFinite(matches[0].prob) || matches[0].prob<0 || matches[0].prob>1)throw new Error("INVALID_LABEL_PROBABILITY");
  probabilities[action]=matches[0].prob;
 }
 const sum=Object.values(probabilities).reduce((a,b)=>a+b,0);
 if(!(sum>0))throw new Error("ZERO_LABEL_MASS");
 for(const key in probabilities)probabilities[key]/=sum;
 // Ignore the sampled token; choose from all measured label scores. Prefer hold on ties.
 const choice=["hold","sell","buy"].reduce((best,key)=>probabilities[key]>probabilities[best]?key:best,"hold");
 const entropy=-Object.values(probabilities).reduce((h,p)=>h+(p>0?p*Math.log(p):0),0);
 return {model,answers:{action:{type:"choice",choice,probabilities,confidence:Math.max(0,Math.min(1,1-entropy/Math.log(3)))}},usage:{input_tokens:prefix.length,output_tokens:1},
  local_scoring:{method:"llama_cpp_label_scores",temperature:1,labels,token_ids:ids,label_mass:sum,scores:scores.filter((s:any)=>Object.values(ids).includes(s.id)),timings:raw.timings}};
}
Bun.serve({hostname:"127.0.0.1",port:8089,idleTimeout:255,maxRequestBodySize:1048576,async fetch(req){
 const path=new URL(req.url).pathname;
 if(req.headers.has("origin") && req.headers.get("origin")!=="http://127.0.0.1:8089")return new Response("Forbidden",{status:403});
 if(req.method==="GET" && path==="/health"){
  try{const r=await fetch(upstream+"/health",{redirect:"error",signal:AbortSignal.timeout(3000)});return Response.json({status:r.ok?"ok":"loading",model},{status:r.ok?200:503});}catch{return Response.json({status:"unavailable"},{status:503});}
 }
 if(req.method!=="POST" || path!=="/v1/systemone")return new Response("Not found",{status:404});
 if(req.headers.get("content-type")?.split(";")[0]!=="application/json")return new Response("JSON required",{status:415});
 if(busy)return Response.json({error:"BUSY"},{status:429});
 busy=true;
 try{return Response.json(await classify(await req.json()),{headers:{"x-inference-model":model}});}
 catch(error:any){return Response.json({error:error.message},{status:502});}
 finally{busy=false;}
}});
console.log("Qwen label-score adapter listening on http://127.0.0.1:8089");
