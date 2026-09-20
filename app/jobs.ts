import { Database } from "bun:sqlite";

export type JobState = "queued" | "collecting" | "evaluating" | "validating" | "done" | "failed";
export interface Job { id: string; symbol: string; mode: "demo" | "live"; state: JobState; progress: number;
  createdAt: string; message: string; input: JobInput; result?: any; quality?: Record<string, string>; }
export interface JobInput { symbol: string; mode: "demo" | "live"; horizon: number; position: "flat" | "long";
  costPercent: number; execution: "next_session_open" | "immediate"; instructions: string; }

export function parseInput(body: any): JobInput {
  if (!body || typeof body !== "object") throw new Error("请填写分析参数。");
  if (!["demo", "live"].includes(body.mode)) throw new Error("请选择演示或真实分析。");
  const symbol = body.mode === "demo" ? "DEMO" : String(body.symbol || "").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.\^-]{0,19}$/.test(symbol)) throw new Error("请输入有效股票代码，例如 600519、AAPL 或 HK00700。");
  if (!Number.isInteger(body.horizon) || body.horizon < 1 || body.horizon > 250) throw new Error("分析周期应为 1 至 250 个交易日。");
  if (!["flat", "long"].includes(body.position)) throw new Error("请选择当前持仓状态。");
  if (!["next_session_open", "immediate"].includes(body.execution)) throw new Error("请选择执行假设。");
  if (typeof body.costPercent !== "number" || !Number.isFinite(body.costPercent) || body.costPercent < 0 || body.costPercent > 10) throw new Error("成本假设应为 0% 至 10%。");
  if (typeof body.instructions !== "string" || body.instructions.length > 8000) throw new Error("策略说明请控制在 8000 字以内。");
  return { symbol, mode: body.mode, horizon: body.horizon, position: body.position,
    costPercent: body.costPercent, execution: body.execution, instructions: body.instructions.trim() };
}

export class JobStore {
  db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, body TEXT NOT NULL)");
    for (const job of this.list()) if (!["done", "failed"].includes(job.state)) {
      this.update({ ...job, state: "failed", message: "上次运行被中断，请重新分析。", progress: 0 });
    }
  }
  list(): Job[] { return (this.db.query("SELECT body FROM jobs ORDER BY rowid DESC LIMIT 100").all() as { body: string }[]).map(r => JSON.parse(r.body)); }
  get(id: string): Job | undefined { const r = this.db.query("SELECT body FROM jobs WHERE id=?").get(id) as {body: string} | null; return r ? JSON.parse(r.body) : undefined; }
  byToken(token: string): Job | undefined { const r = this.db.query("SELECT body FROM jobs WHERE token=?").get(token) as {body: string} | null; return r ? JSON.parse(r.body) : undefined; }
  create(input: JobInput, token: string): Job {
    const job: Job = { id: crypto.randomUUID(), symbol: input.symbol, mode: input.mode, state: "queued", progress: 0,
      createdAt: new Date().toISOString(), message: "正在准备分析", input };
    this.db.run("INSERT INTO jobs VALUES (?,?,?)", [job.id, token, JSON.stringify(job)]);
    return job;
  }
  update(job: Job) { this.db.run("UPDATE jobs SET body=? WHERE id=?", [JSON.stringify(job), job.id]); }
}
