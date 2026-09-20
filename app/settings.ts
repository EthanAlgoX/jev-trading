import { backendName, engineName, legacyEngine, localURL, methods, type Backend, type LocalEngine } from "./backends";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const ROOT = resolve(import.meta.dir, "..");
export const DATA = resolve(process.env.JEV_DATA_DIR || join(ROOT, "data"));
export const PYTHON = join(ROOT, ".venv", "bin", "python");
export const UV = Bun.which("uv") || (existsSync(join(homedir(), ".local/bin/uv")) ? join(homedir(), ".local/bin/uv") : null);

export interface Settings { apiKey: string; model: string; aistockPath: string; aistockPython: string; backend: Backend; localEngine: LocalEngine; localBaseUrl: string; localApiKey: string; localModel: string; localModelId: string; localRevision: string; modelTimeoutSeconds: number }

export function discoverAIStock(projectRoot = ROOT): string {
  const candidates = [process.env.AISTOCK_PATH, "../AI-Stock", "../../AI-Stock", "./AI-Stock"];
  return candidates.filter(Boolean).map(p => resolve(projectRoot, p!))
    .find(p => existsSync(join(p, "src/core/pipeline.py"))) || "";
}

export class SettingsStore {
  readonly path: string;
  constructor(directory = DATA) { mkdirSync(directory, { recursive: true }); this.path = join(directory, "settings.json"); }
  read(override?: Backend, engineOverride?: LocalEngine): Settings {
    const saved = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
    const root = saved.aistockPath || discoverAIStock();
    const originalBackend = saved.backend || process.env.JEV_BACKEND || "jev";
    const defaultBackend = backendName(originalBackend);
    const backend = override ?? defaultBackend;
    const defaultEngine = engineName(saved.localEngine || legacyEngine(originalBackend) || process.env.JEV_LOCAL_ENGINE || "logprobs");
    const localEngine = engineOverride ?? defaultEngine;
    const oldName = localEngine === "generated" ? "localjev" : "openjev_sglang";
    const profile = backend === "local" ? saved.localProfiles?.[localEngine] || saved.localProfiles?.[oldName] || {} : {};
    const useLegacy = localEngine === defaultEngine;
    const prefix = `JEV_LOCAL_${localEngine.toUpperCase()}`;
    const oldPrefix = localEngine === "generated" ? "JEV_LOCALJEV" : "JEV_OPENJEV_SGLANG";
    const localSetting = (field: string, suffix: string, legacyEnv: string, fallback: string) =>
      profile[field] || process.env[`${prefix}_${suffix}`] || process.env[`${oldPrefix}_${suffix}`]
      || (useLegacy ? saved[field] || process.env[legacyEnv] : undefined) || fallback;
    const timeout = Number(backend === "jev"
      ? saved.cloudTimeoutSeconds ?? (defaultBackend === "jev" ? saved.modelTimeoutSeconds : undefined) ?? process.env.JEV_MODEL_TIMEOUT_SECONDS ?? 30
      : profile.modelTimeoutSeconds ?? process.env[`${prefix}_TIMEOUT_SECONDS`] ?? process.env[`${oldPrefix}_TIMEOUT_SECONDS`]
        ?? (useLegacy && defaultBackend === "local" ? saved.modelTimeoutSeconds : undefined) ?? 180);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) throw new Error("模型超时须为 1 至 300 秒。");
    return {
      backend, localEngine, modelTimeoutSeconds: timeout,
      localBaseUrl: localURL(localSetting("localBaseUrl", "BASE_URL", "JEV_LOCAL_BASE_URL", localEngine === "logprobs" ? "http://127.0.0.1:8000" : "http://127.0.0.1:8080")),
      localApiKey: localSetting("localApiKey", "API_KEY", "JEV_LOCAL_API_KEY", ""),
      localModel: localSetting("localModel", "MODEL", "JEV_LOCAL_MODEL", "jev-latest"),
      localModelId: localSetting("localModelId", "MODEL_ID", "JEV_LOCAL_MODEL_ID", ""),
      localRevision: localSetting("localRevision", "MODEL_REVISION", "JEV_LOCAL_MODEL_REVISION", ""),
      apiKey: saved.apiKey || process.env.TYPESAFE_AI_API_KEY || process.env.TYPESAFE_API_KEY || "",
      model: saved.model || process.env.JEV_MODEL_ID || process.env.JEV_MODEL || "jev-latest",
      aistockPath: root,
      aistockPython: saved.aistockPython || (process.env.AISTOCK_PYTHON ? resolve(ROOT, process.env.AISTOCK_PYTHON) : join(root, ".venv/bin/python")),
    };
  }
  public(override?: Backend, engineOverride?: LocalEngine) {
    const value = this.read(override, engineOverride);
    return { configured: Boolean(value.apiKey), model: value.model,
      backend: value.backend, localEngine: value.localEngine, probabilityMethod: methods[value.backend === "jev" ? "jev" : value.localEngine], localBaseUrl: value.localBaseUrl,
      localConfigured: Boolean(value.localApiKey), localModel: value.localModel,
      localModelId: value.localModelId, localRevision: value.localRevision, modelTimeoutSeconds: value.modelTimeoutSeconds,
      aistockPath: value.aistockPath, aistockPython: value.aistockPython };
  }
  save(input: Record<string, unknown>) {
    const saved = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {};
    const current = this.read(input.backend === undefined ? undefined : backendName(input.backend), input.localEngine === undefined ? legacyEngine(input.backend) : engineName(input.localEngine));
    for (const name of ["apiKey", "model", "aistockPath", "aistockPython", "localApiKey", "localBaseUrl", "localModel", "localModelId", "localRevision"] as const) {
      if (input[name] !== undefined && typeof input[name] !== "string") throw new Error("配置格式不正确");
      if (typeof input[name] === "string" && input[name].trim()) current[name] = input[name].trim();
    }
    if (input.backend !== undefined) current.backend = backendName(input.backend);
    // Optional audit labels may be cleared, unlike stored credentials.
    for (const name of ["localModelId", "localRevision"] as const) if (typeof input[name] === "string") current[name] = input[name].trim();
    if (input.modelTimeoutSeconds !== undefined) {
      if (!Number.isInteger(input.modelTimeoutSeconds) || Number(input.modelTimeoutSeconds) < 1 || Number(input.modelTimeoutSeconds) > 300) throw new Error("模型超时须为 1 至 300 秒。");
      current.modelTimeoutSeconds = Number(input.modelTimeoutSeconds);
    }
    current.localBaseUrl = localURL(current.localBaseUrl);
    if (current.localApiKey.length > 4096 || /[\r\n]/.test(current.localApiKey) || [current.localModel,current.localModelId,current.localRevision].some(v => v.length > 500)) throw new Error("本地模型配置格式不正确。");
    if (current.apiKey.length > 4096 || current.model.length > 200 || /[\r\n]/.test(current.apiKey)) throw new Error("密钥或模型格式不正确");
    if (current.aistockPath) current.aistockPath = resolve(ROOT, current.aistockPath);
    if (current.aistockPython) current.aistockPython = resolve(ROOT, current.aistockPython);
    const temporary = this.path + ".tmp";
    const profiles = { ...saved.localProfiles };
    // Preserve a pre-profile local configuration when switching away from it.
    const old = this.read();
    for (const value of [old, current]) if (value.backend !== "jev") {
      profiles[value.localEngine] = Object.fromEntries(["localBaseUrl", "localApiKey", "localModel", "localModelId", "localRevision", "modelTimeoutSeconds"].map(k => [k, value[k as keyof Settings]]));
    }
    writeFileSync(temporary, JSON.stringify({ ...current, cloudTimeoutSeconds: current.backend === "jev" ? current.modelTimeoutSeconds : old.backend === "jev" ? old.modelTimeoutSeconds : saved.cloudTimeoutSeconds, localProfiles: profiles }, null, 2), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    return this.public();
  }
}

export function readiness(settings: SettingsStore, override?: Backend, engineOverride?: LocalEngine, suppliedContext = false) {
  const value = settings.read(override, engineOverride);
  const source = join(value.aistockPath, "src/core/pipeline.py");
  const checks = [
    { id: "python", label: "决策运行环境", ok: existsSync(PYTHON), hint: "在项目目录运行 bun run start，自动准备 Python 依赖。" },
    { id: "aistock", label: "AIStock 数据源", ok: existsSync(source), hint: "在连接设置中选择 AIStock 项目目录。" },
    { id: "collector", label: "AIStock Python 环境", ok: existsSync(value.aistockPython), hint: "选择已安装 AIStock 依赖的 Python 解释器。" },
    { id: "patch", label: "单股数据采集入口", ok: existsSync(source) && readFileSync(source, "utf8").includes("context_only: bool = False"), hint: "参照使用说明应用 patches/aistock-context-only.patch。" },
    value.backend === "jev"
      ? { id: "key", label: "Jev API Key", ok: Boolean(value.apiKey), hint: "在连接设置中填写 API Key，或配置 .env。" }
      : { id: "local", label: "本地决策引擎地址已配置（未探测连接）", ok: Boolean(value.localBaseUrl), hint: "运行 bun run backend:check 验证本地推理服务。" },
  ];
  return { checks, ready: checks.filter(c => !suppliedContext || !["aistock", "collector", "patch"].includes(c.id)).every(c => c.ok), demoReady: checks[0].ok, settings: settings.public(override, engineOverride) };
}
