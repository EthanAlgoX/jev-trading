import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const ROOT = resolve(import.meta.dir, "..");
export const DATA = resolve(process.env.JEV_DATA_DIR || join(ROOT, "data"));
export const PYTHON = join(ROOT, ".venv", "bin", "python");
export const UV = Bun.which("uv") || (existsSync(join(homedir(), ".local/bin/uv")) ? join(homedir(), ".local/bin/uv") : null);

export interface Settings { apiKey: string; model: string; aistockPath: string; aistockPython: string }

export function discoverAIStock(projectRoot = ROOT): string {
  const candidates = [process.env.AISTOCK_PATH, "../AI-Stock", "../../AI-Stock", "./AI-Stock"];
  return candidates.filter(Boolean).map(p => resolve(projectRoot, p!))
    .find(p => existsSync(join(p, "src/core/pipeline.py"))) || "";
}

export class SettingsStore {
  readonly path: string;
  constructor(directory = DATA) { mkdirSync(directory, { recursive: true }); this.path = join(directory, "settings.json"); }
  read(): Settings {
    const saved = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
    const root = saved.aistockPath || discoverAIStock();
    return {
      apiKey: saved.apiKey || process.env.TYPESAFE_AI_API_KEY || process.env.TYPESAFE_API_KEY || "",
      model: saved.model || process.env.JEV_MODEL_ID || process.env.JEV_MODEL || "jev-latest",
      aistockPath: root,
      aistockPython: saved.aistockPython || (process.env.AISTOCK_PYTHON ? resolve(ROOT, process.env.AISTOCK_PYTHON) : join(root, ".venv/bin/python")),
    };
  }
  public() {
    const value = this.read();
    return { configured: Boolean(value.apiKey), model: value.model,
      aistockPath: value.aistockPath, aistockPython: value.aistockPython };
  }
  save(input: Record<string, unknown>) {
    const current = this.read();
    for (const name of ["apiKey", "model", "aistockPath", "aistockPython"] as const) {
      if (input[name] !== undefined && typeof input[name] !== "string") throw new Error("配置格式不正确");
      if (typeof input[name] === "string" && input[name].trim()) current[name] = input[name].trim();
    }
    if (current.apiKey.length > 4096 || current.model.length > 200 || /[\r\n]/.test(current.apiKey)) throw new Error("密钥或模型格式不正确");
    if (current.aistockPath) current.aistockPath = resolve(ROOT, current.aistockPath);
    if (current.aistockPython) current.aistockPython = resolve(ROOT, current.aistockPython);
    const temporary = this.path + ".tmp";
    writeFileSync(temporary, JSON.stringify(current, null, 2), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    return this.public();
  }
}

export function readiness(settings: SettingsStore) {
  const value = settings.read();
  const source = join(value.aistockPath, "src/core/pipeline.py");
  const checks = [
    { id: "python", label: "决策运行环境", ok: existsSync(PYTHON), hint: "在项目目录运行 bun run start，自动准备 Python 依赖。" },
    { id: "aistock", label: "AIStock 数据源", ok: existsSync(source), hint: "在连接设置中选择 AIStock 项目目录。" },
    { id: "collector", label: "AIStock Python 环境", ok: existsSync(value.aistockPython), hint: "选择已安装 AIStock 依赖的 Python 解释器。" },
    { id: "patch", label: "单股数据采集入口", ok: existsSync(source) && readFileSync(source, "utf8").includes("context_only: bool = False"), hint: "参照使用说明应用 patches/aistock-context-only.patch。" },
    { id: "key", label: "Jev API Key", ok: Boolean(value.apiKey), hint: "在连接设置中填写 API Key，或配置 .env。" },
  ];
  return { checks, ready: checks.every(c => c.ok), demoReady: checks[0].ok, settings: settings.public() };
}
