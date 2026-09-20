import { Database } from "bun:sqlite";

export interface Strategy { id: string; name: string; instructions: string; version: number; updatedAt: string }
export interface CollectionOptions { quote?: boolean; chip?: boolean; news?: boolean; realtimeSources?: string[] }
export const realtimeSources = ["tencent", "akshare_sina", "efinance", "akshare_em"];
export function collectionOptions(value: unknown): CollectionOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("collection 必须是对象。");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(k => !["quote", "chip", "news", "realtimeSources"].includes(k))) throw new Error("未知采集选项。");
  const result: CollectionOptions = {};
  for (const key of ["quote", "chip", "news"] as const) if (body[key] !== undefined) {
    if (typeof body[key] !== "boolean") throw new Error(`${key} 必须是布尔值。`);
    result[key] = body[key];
  }
  if (body.realtimeSources !== undefined) {
    const sources = body.realtimeSources;
    if (!Array.isArray(sources) || !sources.length || sources.length > 4 || new Set(sources).size !== sources.length || sources.some(s => !realtimeSources.includes(s))) throw new Error("实时行情来源应为不重复的受支持来源列表。");
    result.realtimeSources = sources;
  }
  return result;
}
export class StrategyStore {
  db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("CREATE TABLE IF NOT EXISTS strategies(id TEXT PRIMARY KEY, body TEXT NOT NULL)");
  }
  list(): Strategy[] { return (this.db.query("SELECT body FROM strategies ORDER BY rowid DESC").all() as {body:string}[]).map(r => JSON.parse(r.body)); }
  get(id: string): Strategy | undefined { const row = this.db.query("SELECT body FROM strategies WHERE id=?").get(id) as {body:string} | null; return row ? JSON.parse(row.body) : undefined; }
  save(body: any): Strategy {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !["id", "name", "instructions"].includes(k))) throw new Error("策略格式不正确。");
    if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 80 || typeof body.instructions !== "string" || !body.instructions.trim() || body.instructions.length > 8000) throw new Error("策略名称需为 1–80 字，提示词需为 1–8000 字。");
    if (body.id !== undefined && (typeof body.id !== "string" || !this.get(body.id))) throw new Error("策略不存在，请重新加载。");
    const previous = body.id ? this.get(body.id) : undefined;
    const strategy = {id: previous?.id ?? crypto.randomUUID(), name: body.name.trim(), instructions: body.instructions.trim(), version: (previous?.version ?? 0) + 1, updatedAt: new Date().toISOString()};
    this.db.run("INSERT OR REPLACE INTO strategies VALUES (?,?)", [strategy.id, JSON.stringify(strategy)]);
    return strategy;
  }
  delete(id: string) { return this.db.run("DELETE FROM strategies WHERE id=?", [id]).changes > 0; }
}
