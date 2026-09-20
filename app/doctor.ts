import { SettingsStore, readiness, UV } from "./settings";

console.log("\nJev 股票决策 · 环境检查\n");
console.log(`${UV ? "✓" : "✗"} uv ${UV ? "可用" : "未安装，请访问 https://docs.astral.sh/uv/"}`);
const result = readiness(new SettingsStore());
for (const check of result.checks) console.log(`${check.ok ? "✓" : "✗"} ${check.label}${check.ok ? "" : `：${check.hint}`}`);
console.log(`\n${result.ready ? "真实分析已就绪。" : "真实分析仍需以上配置；可先体验演示模式。"}\n启动：bun run start\n`);
