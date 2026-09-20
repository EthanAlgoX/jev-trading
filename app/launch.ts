import { ROOT, UV } from "./settings";

if (!UV) {
  console.error("尚未安装 uv。请先安装：https://docs.astral.sh/uv/getting-started/installation/\n完成后重新执行 bun run start。");
  process.exit(1);
}
console.log("正在检查决策运行环境（首次启动会安装 Python 依赖）…");
const setup = Bun.spawn([UV, "sync", "--frozen", "--no-dev"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
if (await setup.exited !== 0) { console.error("依赖准备失败。请检查网络后重新执行 bun run start。"); process.exit(1); }
const { server } = await import("./server");
if (process.env.OPEN_BROWSER !== "0" && process.stdout.isTTY && process.platform === "darwin") {
  Bun.spawn(["open", `http://127.0.0.1:${server.port}`], { stdout: "ignore", stderr: "ignore" });
}
