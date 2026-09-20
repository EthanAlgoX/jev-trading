import { ApiError, apiInput, decisionResponse, waitForJob } from "./api";
import page from "../web/index.html";
import { join } from "node:path";
import { DATA, SettingsStore, readiness, type Settings } from "./settings";
import { JobStore, parseInput, type Job, type JobInput } from "./jobs";
import { bridge, collectStock, pythonJSON } from "./python";
import { classifyWithBackend, inferenceMetadata } from "./model";
import { StrategyStore } from "./customization";
import { demoContext, demoResponse } from "./demo";

const settings = new SettingsStore();
const jobs = new JobStore(join(DATA, "workbench.sqlite"));
const strategies = new StrategyStore(join(DATA, "strategies.sqlite"));
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();
const tasks = new Map<string, Promise<void>>();
let activeJob: string | null = null;
const port = Number(process.env.PORT || 3000);
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
function send(controller: ReadableStreamDefaultController<Uint8Array>, type: string, value: unknown) {
  try { controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)); }
  catch { clients.delete(controller); }
}
function update(job: Job, changes: Partial<Job>) {
  Object.assign(job, changes); jobs.update(job);
  for (const client of clients) send(client, "job", job);
}

async function execute(job: Job, current: Settings) {
  const config = { horizon: `未来 ${job.input.horizon} 个交易日`, execution_assumption: job.input.execution,
    cost_assumption: `买卖合计成本及滑点假设为成交金额的 ${job.input.costPercent}%，不代表实际费率。`,
    strategy_instructions: job.input.instructions || job.strategy?.instructions || "综合技术面、基本面、新闻、筹码与市场环境，证据不足时观望。",
    position: { state: job.input.position }, validity_seconds: job.input.execution === "immediate" ? 120 : 3600,
    request_timeout_seconds: current.modelTimeoutSeconds };
  try {
    update(job, { state: "collecting", progress: 15, message: job.mode === "demo" ? "载入合成演示数据" : job.input.context ? "正在检查自带数据快照" : "正在收集行情、新闻、基本面和技术指标，通常需要数十秒" });
    const context = job.mode === "demo" ? demoContext() : job.input.context ? structuredClone(job.input.context) : await collectStock(job.symbol, current, job.id, job.input.collection);
    context.provenance = {...context.provenance, decision_input: {
      source: job.mode === "demo" ? "demo" : job.input.context ? "supplied" : "aistock",
      collection: job.input.collection ?? null, strategy: job.strategy ?? null,
      instructions_override: Boolean(job.input.instructions),
    }};
    const quality = Object.fromEntries(Object.entries(context.pack.blocks).map(([name, value]: [string, any]) => [name, value.status]));
    const model = job.mode === "demo" ? "offline-example-not-a-live-model" : current.backend === "jev" ? current.model : current.localModel;
    const prepared = await bridge({ operation: "prepare", context, config, model });
    update(job, { state: "evaluating", progress: 65, quality,
      message: prepared.reasons.length ? "数据校验发现限制，正在记录原因" : job.mode === "demo" ? "展示示例分类响应（未调用 Jev）" : "数据已就绪，Jev 正在判断买入、卖出或观望" });
    let inference = job.mode === "demo" ? undefined : inferenceMetadata(current);
    let response: unknown = null, errorCode: string | undefined, latency = 0;
    if (!prepared.reasons.length) {
      if (job.mode === "demo") response = demoResponse();
      else {
        const started = performance.now();
        try { const result = await classifyWithBackend(prepared.request, current); response = result.raw; latency = result.latencyMs; inference = result.inference; }
        catch (error: any) {
          latency = Math.round(performance.now() - started);
          errorCode = ["TimeoutError", "AbortError"].includes(error?.name) ? "MODEL_TIMEOUT"
            : error?.statusCode ? `MODEL_HTTP_${error.statusCode}` : "MODEL_REQUEST_FAILED";
        }
      }
    }
    update(job, { state: "validating", progress: 90, message: "正在校验动作并保存决策依据" });
    const result = await bridge({ operation: "complete", context, config, model, response,
      error_code: errorCode, latency_ms: latency, inference, demo: job.mode === "demo", job_id: job.id,
      database: join(DATA, "decisions.db") });
    update(job, { state: "done", progress: 100, result,
      message: result.status === "error" ? "模型调用未成功，已保存错误记录" : "分析完成" });
  } catch (error: any) {
    update(job, { state: "failed", progress: 0, message: error.message || "分析未完成，请检查连接后重新尝试。" });
  } finally { activeJob = null; }
}

async function submit(input: JobInput, token: string): Promise<Job> {
  if (!/^[a-zA-Z0-9-]{8,100}$/.test(token)) throw new ApiError("INVALID_IDEMPOTENCY_KEY", "Idempotency-Key 应为 8 至 100 位字母、数字或连字符。");
  const previous = jobs.byToken(token);
  if (previous) {
    if (JSON.stringify(previous.input) !== JSON.stringify(input)) throw new ApiError("IDEMPOTENCY_CONFLICT", "相同请求标识对应不同参数。", 409);
    return previous;
  }
  if (input.context) {
    try { await bridge({operation: "validate_context", context: input.context}); }
    catch { throw new ApiError("INVALID_CONTEXT", "数据快照格式不正确，请参阅 docs/customization.md。"); }
    const existing = jobs.byToken(token);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw new ApiError("IDEMPOTENCY_CONFLICT", "相同请求标识对应不同参数。", 409);
      return existing;
    }
  }
  const strategy = input.strategyId ? strategies.get(input.strategyId) : undefined;
  if (input.strategyId && !strategy) throw new ApiError("STRATEGY_NOT_FOUND", "策略不存在。", 404);
  if (activeJob) throw new ApiError("BUSY", "已有分析正在运行，请稍后重试。", 409);
  const state = readiness(settings, input.backend, input.localEngine, Boolean(input.context));
  const current = settings.read(input.backend, input.localEngine);
  if (!(input.mode === "demo" ? state.demoReady : state.ready)) throw new ApiError("NOT_READY", "环境未就绪，请运行 bun run doctor 或查看 /v1/health。", 503);
  const job = jobs.create(input, token);
  job.strategy = strategy;
  job.backend = input.mode === "demo" ? "recorded" : current.backend; jobs.update(job);
  activeJob = job.id;
  const task = execute(job, current).finally(() => tasks.delete(job.id));
  tasks.set(job.id, task);
  return job;
}

function trustedRequest(req: Request) {
  const url = new URL(req.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
  const origin = req.headers.get("origin");
  if (origin && origin !== url.origin) return false;
  if (url.pathname.startsWith("/v1/")) return req.method === "GET" ||
    req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "application/json";
  return req.method === "GET" || req.headers.get("x-jev-request") === "1";
}

export const server = Bun.serve({
  hostname: "127.0.0.1", port, maxRequestBodySize: 1_048_576, idleTimeout: 60,
  development: process.env.NODE_ENV === "development",
  routes: { "/": page },
  async fetch(req) {
    if (!trustedRequest(req)) return json({ error: { code: "FORBIDDEN", message: "仅接受同源页面或本机 HTTP 客户端的 JSON 请求。" } }, 403);
    const url = new URL(req.url);
    try {
      if (["/v1/strategies", "/api/strategies"].includes(url.pathname)) {
        if (req.method === "GET") return json(strategies.list());
        if (req.method === "POST") return json(strategies.save(await req.json()));
      }
      const strategyMatch = url.pathname.match(/^\/(?:v1|api)\/strategies\/([a-f0-9-]{36})$/);
      if (req.method === "DELETE" && strategyMatch) {
        if (!strategies.delete(strategyMatch[1])) throw new ApiError("STRATEGY_NOT_FOUND", "策略不存在。", 404);
        return json({deleted: true});
      }
      if (req.method === "GET" && url.pathname === "/v1/backends") {
        return json({ default_backend: settings.read().backend, local_engines: (["generated", "logprobs"] as const).map(localEngine => { const state = readiness(settings, "local", localEngine); return {localEngine, probability_method: state.settings.probabilityMethod, configured: state.ready, model: state.settings.localModel}; }), backends: (["jev", "local"] as const).map(backend => {
          const state = readiness(settings, backend);
          return { backend, configured: state.ready, probability_method: state.settings.probabilityMethod,
            model: backend === "jev" ? state.settings.model : state.settings.localModel,
            checks: state.checks };
        }) });
      }
      if (req.method === "GET" && url.pathname === "/v1/health") {
        const state = readiness(settings);
        return json({ api_version: "1", status: "ok", ready: state.ready, demo_ready: state.demoReady, supplied_context_ready: readiness(settings, undefined, undefined, true).ready, checks: state.checks, active_request_id: activeJob, inference_backend: state.settings.backend, probability_method: state.settings.probabilityMethod });
      }
      if (req.method === "POST" && url.pathname === "/v1/decisions") {
        const { input, wait } = apiInput(await req.json());
        const job = await submit(input, req.headers.get("idempotency-key") || crypto.randomUUID());
        await waitForJob(tasks.get(job.id), wait);
        const current = jobs.get(job.id)!;
        const response = json(decisionResponse(current), ["done", "failed"].includes(current.state) ? 200 : 202);
        response.headers.set("location", `/v1/decisions/${job.id}`);
        if (response.status === 202) response.headers.set("retry-after", "2");
        return response;
      }
      const decisionMatch = url.pathname.match(/^\/v1\/decisions\/([a-f0-9-]+)$/);
      if (req.method === "GET" && decisionMatch) {
        const job = jobs.get(decisionMatch[1]);
        if (!job) throw new ApiError("NOT_FOUND", "未找到该决策请求。", 404);
        return json(decisionResponse(job));
      }
      if (req.method === "GET" && url.pathname === "/api/status") return json({ ...readiness(settings), profiles: {jev: settings.public("jev"), local: settings.public("local"), generated: settings.public("local", "generated"), logprobs: settings.public("local", "logprobs")}, activeJob });
      if (req.method === "GET" && url.pathname === "/api/jobs") return json(jobs.list());
      if (req.method === "GET" && url.pathname === "/api/events") {
        let controller: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({
          start(c) { controller = c; clients.add(c); send(c, "snapshot", jobs.list()); },
          cancel() { clients.delete(controller); },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      if (req.method === "POST" && url.pathname === "/api/settings") {
        if (activeJob) return json({ error: "分析运行中，请完成后再更改连接设置。" }, 409);
        settings.save(await req.json()); return json(readiness(settings));
      }
      if (req.method === "POST" && url.pathname === "/api/jobs") {
        const token = req.headers.get("idempotency-key");
        if (!token) throw new ApiError("INVALID_IDEMPOTENCY_KEY", "缺少请求标识，请刷新后重试。");
        return json(await submit(parseInput(await req.json()), token), 202);
      }
      const match = url.pathname.match(/^\/(?:api\/jobs|v1\/decisions)\/([a-f0-9-]+)\/(?:export|evidence)$/);
      if (req.method === "GET" && match) {
        const job = jobs.get(match[1]);
        if (!job) throw new ApiError("NOT_FOUND", "未找到该决策请求。", 404);
        if (!job.result) throw new ApiError("EVIDENCE_NOT_READY", "该分析尚无可导出的结果。", 409);
        const evidence = await pythonJSON(["-m", "jev_trading.cli", "show", job.result.decision_id, "--db", join(DATA, "decisions.db")]);
        return new Response(JSON.stringify(evidence, null, 2), { headers: { "content-type": "application/json",
          "content-disposition": `attachment; filename="decision-${job.symbol}-${job.id.slice(0, 8)}.json"` } });
      }
      throw new ApiError("NOT_FOUND", "未找到此接口。", 404);
    } catch (error: any) {
      return json(url.pathname.startsWith("/v1/")
        ? { error: { code: error instanceof ApiError ? error.code : "INVALID_REQUEST", message: error.message || "请求失败" } }
        : { error: error.message || "请求失败，请重试。" }, error instanceof ApiError ? error.status : 400);
    }
  },
});

const heartbeat = setInterval(() => { for (const c of clients) send(c, "ping", Date.now()); }, 15_000);
heartbeat.unref();
console.log(`\nJev 股票决策工作台已启动：http://127.0.0.1:${server.port}\nHTTP API：POST /v1/decisions，健康检查：GET /v1/health。网页为可选辅助入口。\n`);
