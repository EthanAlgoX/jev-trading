import { DATA, PYTHON, ROOT, type Settings } from "./settings";
import { join } from "node:path";

export async function pythonJSON(args: string[], input?: unknown, timeout = 350_000, env: Record<string, string> = {}): Promise<any> {
  const child = Bun.spawn([PYTHON, ...args], { cwd: ROOT,
    env: { ...process.env, ...env, PYTHONPATH: join(ROOT, "src") },
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(JSON.stringify(input)), stdout: "pipe", stderr: "pipe" });
  let expired = false;
  const timer = setTimeout(() => { expired = true; child.kill(); }, timeout);
  try {
    const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (expired) throw new Error("步骤超时，请重新尝试。采集详情见 data/collection.log。");
    if (code !== 0) {
      // Do not leak a provider response or configuration secrets into browser errors.
      console.error(`Python step failed (${args[1] || args[0]}, exit ${code}, stderr ${error.length} chars)`);
      throw new Error("分析步骤未完成。请检查连接设置；数据采集详情见 data/collection.log。");
    }
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

export async function collectStock(symbol: string, settings: Settings, jobId: string, collection?: import("./customization").CollectionOptions) {
  const output = join(DATA, "contexts", `${jobId}.json`);
  await pythonJSON(["-m", "jev_trading.cli", "collect", "--symbol", symbol, "--output", output,
    "--aistock-path", settings.aistockPath, "--aistock-python", settings.aistockPython,
    "--data-dir", DATA, "--collection-timeout", "240", ...(collection ? ["--collection-options", JSON.stringify(collection)] : [])], undefined, 260_000);
  return Bun.file(output).json();
}

export function bridge(payload: unknown) { return pythonJSON(["-m", "jev_trading.bridge"], payload, 30_000); }
