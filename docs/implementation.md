# 首版开发记录

日期：2026-09-20。本文记录首版 CLI 交付；后续新增的网页工作台、SDK 接入与验证见 [网页版本记录](workbench.md)。

## 已实现

1. **AIStock 采集出口**：在本地 `AI-Stock/src/core/pipeline.py` 增加 `context_only=True`，复用行情、技术指标、新闻、筹码、基本面采集，在报告生成前返回 `PipelineAnalysisArtifacts`。显式绕过 Agent、报告模型、报告保存与通知。原报告模式保持默认行为。
2. **独立运行适配**：`aistock_worker.py` 在 AIStock 原 Python 环境采集，`collector.py` 管理子进程、超时与输出。数据写入 `jev-trading/data/aistock.db`，没有写入用户原有研究数据库。完整 pack、增强上下文与最多 90 根历史行情保留到快照。
3. **Jev 分类**：官方 HTTP Choice 接口，单次 buy/sell/hold；判断周期、执行假设、成本、持仓和策略显式传入。校验三类概率、动作一致性、有限数值、模型版本；硬超时取消请求，不自动重试。
4. **决策护栏**：核心数据状态、交易日对应、快照有效期、即刻执行的开市与报价时效、保守市场、调用方买卖权限与仅做多持仓语义。原始动作与最终动作分开记录。
5. **持久化**：SQLite 保存输入、精确请求、原始响应、最终决策和规则修改轨迹。相同输入幂等；过期查询返回 hold/expired 视图，原始证据不覆盖。显式 retry-token 产生独立尝试。
6. **CLI**：`collect`、`decide`、`show`；提供配置和离线示例。安装用 `uv sync`，运行用 `uv run jev-trading`。

## 与规划的具体差异

- 为减少耦合，决策保存采用本项目的 SQLite 合同，未向 AIStock 既有、面向报告的 DecisionSignal 表塞入不兼容字段。
- 当前护栏不是原报告护栏的全量迁移。报告中依赖评分、价位建议和解释文本的规则未直接复用；保守市场输入判断复用了 AIStock 的 `_is_conservative_context`，该私有接口属于需要版本核验的适配边界。
- 当前持仓是调用方明确提供的 flat / long / unknown 及可选权限，不自动读取个人账户，也不校验真实资金和交易数量。
- 时间周期和成本均在配置中明确指定；示例参数不等于已验证策略。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `uv sync` | 成功，生成 uv.lock 和独立虚拟环境 |
| 本项目 `uv run pytest -q` | 33 项通过 |
| AIStock 采集、市场阶段、上下文构建、数据获取相关回归 | 45 项通过 |
| Python compileall / AIStock backend gate syntax | 通过 |
| 本项目 flake8 critical（E9,F63,F7,F82） | 通过 |
| 可移植补丁 reverse check | 通过，证明本地已含配套修改 |
| CLI 合成数据 → 离线分类 → SQLite → show | 成功 |
| 真实 AIStock `600519` 数据采集 | 成功 |
| 真实输入 + 离线示例响应 | 成功触发技术数据降级护栏，buy → hold |
| 真实 Jev 在线推理 | 未验证，执行环境未提供 TYPESAFE_API_KEY |

测试覆盖模型超时、非 JSON/HTTP 错误、缺失或无效概率、迟到结果、持仓未知与空仓卖出、保守市场、数据过期、报价时间、幂等与显式重试，以及 CLI 输出、凭据缺失、虚拟环境解释器路径。

AIStock 回归测试使用数据边界替身，但实际执行采集分支，验证 Agent 配置或 Skill 配置不会让 context_only 进入报告流程。真实采集另行验证了依赖初始化与外部数据源接入。

未运行 AIStock 全仓库测试、前端构建或实盘交易测试；本次未改前端和执行器。完整风控等价性与交易收益不在上述通过结论内。

## 真实采集观察

采集开始于 `2026-09-20T11:31:05Z`，证券 `600519`，市场阶段 non_trading，市场日历给出的最近完整交易日为 `2026-09-18`。

- 取得 43 根历史行情。
- quote、daily_bars、news 为 available。
- technical、fundamentals 为 partial，chip 为 missing。
- AIStock 将实时行情覆盖标为 `intraday_realtime_overlay`，因此技术块未被视为完整数据。
- 本项目保留该标记；离线示例响应中的 buy 被改为 hold，原因 `DEGRADED_TECHNICAL`。
- 独立采集数据库中 `stock_daily=43`、`analysis_history=0`、`decision_signals=0`，没有生成研究报告。

这验证了采集与护栏链路，不代表 Jev 曾判断这只股票应该买入。响应来自 `examples/recorded-response.json`，输出明确标为 recorded。

本地运行产物在 `data/600519-context.json`、`data/demo-signal.json`、`data/demo-evidence.json` 和 `data/decisions.db`，均被 .gitignore 排除。运行产物会过期，不能当成持续有效的交易信号。

## 配套修改与回滚

AIStock 的本次修改限于 `src/core/pipeline.py`、新增 `tests/test_pipeline_context_only.py`、新增 `docs/context-only-analysis.md` 和 CHANGELOG 新增一条。既有工作区其他改动未覆盖，未执行 commit/push。

`patches/aistock-context-only.patch` 包含流水线修改、新测试和新文档；CHANGELOG 的单条说明需在其他 checkout 应用时自行合并，避免把其他开发中的记录带入补丁。许可副本为 `patches/AIStock-LICENSE`。

开发期间 AIStock 的 HEAD 有外部更新；补丁最终针对本地 `52ef0e896ce57f3bf4532d77a53943e5d2949ba2` 工作树验证。快照还记录了相关源码文件哈希，避免只用 HEAD 忽略未提交修改。

回滚先检查 `git apply --reverse --check`，再反向应用配套补丁，并只移除本次 CHANGELOG 条目。不要 reset 整个 AIStock 工作区。停止使用本项目 CLI 即停止新决策；数据文件可保留用于审计。
