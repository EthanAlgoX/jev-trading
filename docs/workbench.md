# 网页工作台实现与验证

日期：2026-09-20。

后续已将本地 HTTP 服务设为主要入口，网页保留为辅助界面。使用 `bun run serve` 启动，接口与客户端见 [HTTP API](http-api.md)。新增 3 项 API 测试（含独立进程 HTTP 集成），当前共 10 项 Bun 测试通过。

用户从网页输入股票、持仓状态和评估周期，应用负责采集、分类、校验及记录。默认演示无需密钥，真实分析在连接设置完成后开启。启动与日常使用见 [README](../README.md)。

## 调用链路

```text
start.command / bun run start
  → Bun 本地服务与网页
  → AIStock Python 环境：只采集数据及指标
  → Python bridge：构造分类问题、检查输入
  → Bun：createTypeSafeAi → evaluationModel → experimental_evaluate
  → Python bridge：校验原始响应、执行动作护栏、保存审计依据
  → 网页：最终决策、概率、限制原因、历史与导出
```

模型接入沿用参考项目 `reference/src/model.ts` 的 TypeSafe AI SDK 方式，固定 `@ai-sdk/typesafe-ai@3.0.0`、`ai@7.0.103`，使用 `TYPESAFE_AI_API_KEY`。新增 hold 选项，判断周期、持仓和执行成本来自股票业务配置。Python 高级 CLI 保留原 HTTP 接口；网页真实推理走 Bun SDK。

保留 SDK 的原始 provider response，以保存实际模型版本、原始概率和置信度；不把 SDK 归一化后的简化对象当作审计原文。SDK 的三分类概率可能保留两位小数，程序允许总和因舍入偏离 1 最多 0.015，并记录舍入提示，不擅自重新归一化。

## 上手与恢复

- macOS 可双击启动器；已有 Node.js/npm 时可临时准备 Bun。需要 uv，首次启动自动安装本项目 Python 依赖。
- 自动发现同级或上两级的 AIStock；路径与 Python 解释器均可在页面更改。
- 环境检查验证目录、解释器文件与采集入口是否存在；不宣称完成所有依赖导入或外部数据源连通性测试。
- 演示使用合成数据和固定分类响应，界面及记录均明确标注，绝不自动转为在线推理。
- SSE 推送阶段进度，每 15 秒心跳，服务空闲超时 60 秒；断开后自动重连并恢复历史。
- SQLite 保存任务和结果；刷新不丢失。进程重启将中断任务标为失败，由用户决定是否重新分析。
- 同时只运行一个任务；请求幂等，模型超时不自动重试，避免隐式重复付费。

## 本机数据

`data/settings.json` 保存连接配置，权限 0600；API 不返回密钥。`data/workbench.sqlite` 保存任务历史，`data/decisions.db` 保存完整输入、问题、原始响应与最终信号。导出来自审计库，页面最多显示最近 100 个任务。

服务只监听 127.0.0.1，API 检查 Host、Origin 及写请求标记。不包含互联网部署所需的多用户认证。设置、数据、密钥与浏览器验证产物已排除出 Git。

## 验证结果

- TypeScript 严格类型检查通过。
- Bun：7 项测试通过，涵盖密钥隔离、路径发现、参数约束、任务恢复、SDK 请求格式、无重试与跨运行时持久化。
- Python：34 项测试通过，涵盖合同、风控、超时、存储与 CLI。
- 使用真实 SDK 配合模拟 HTTP 响应，验证请求 endpoint、鉴权、三分类问题及原始响应保留。
- 浏览器检查 1440px 桌面与 390px 手机布局；演示结果、持久历史、设置及真实模式缺失密钥提示正常。
- 导出包含 context、request、raw_response、signal；演示记录标记 recorded。跨来源写请求返回 403，SSE 心跳跨越默认空闲时间仍保持连接。

未提供真实 Jev API Key，因此尚未验证在线推理或账户权限；以上 SDK 测试不等同于在线服务验证。AIStock 真实采集的首版验证见 [首版开发记录](implementation.md)。本项目不执行真实订单，分类概率不代表盈利胜率。
