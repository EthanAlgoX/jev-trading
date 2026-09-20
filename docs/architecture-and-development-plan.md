# AIStock 单股分析输出层改造方案

状态：按用户澄清修订；CLI 决策链路及网页工作台已实现，详见 [首版记录](implementation.md) 和 [网页版本记录](workbench.md)。更新日期：2026-09-20。

当前交付以用户自行部署的 HTTP 服务为主要入口：`POST /v1/decisions` 提交并短时等待结果，`GET /v1/decisions/{id}` 查询耗时任务；网页为可选辅助入口。不提供托管 API。详见 [服务调用约定](http-api.md)。

## 1. 需求定义

参考 AIStock 的单股分析：保留多源数据采集和确定性指标计算，把末端的报告生成改为 Jev 分类决策，输出可供股票交易流程消费的结构化信号。

本次核心改动是分析输出层。纸面账本、组合管理、自动下单和交易界面不属于当前改造的必要交付物。

此前方案中的 A 股、日线、5 个交易日、趋势回踩、固定仓位步长和下一开盘成交，均为助手提出的假设，不是用户已确认的需求，本版不再将它们作为架构前提。

## 2. 改造前后

依据用户提供的 AIStock 介绍，原流程可概括为：

```text
股票代码
  → 行情、历史 K 线、基本面、新闻、筹码、市场环境
  → 数据整理与确定性技术指标
  → LLM 综合分析并生成报告
  → 报告中的操作建议
```

拟议流程：

```text
股票代码 + 决策配置 + 持仓上下文
  → 原有多源数据采集
  → 原有确定性指标计算
  → 结构化分析上下文
  → Jev 分类判断
  → 现有护栏适配与结果校验
  → DecisionSignal
```

不需要先生成完整报告，再从报告抽取买卖建议。Jev 直接读取分析所需的信息，承担末端的综合判断。

## 3. 保留与替换

| 部分 | 处理方式 |
| --- | --- |
| 行情、历史 K 线、新闻、基本面、筹码等数据源 | 尽量保留 AIStock 的采集能力与降级机制 |
| MA、MACD、RSI、量价与支撑压力 | 保留确定性计算 |
| 数据来源、时点、缺失与质量信息 | 随分析上下文传给决策层 |
| 策略与分析规则 | 整理为 Jev 判断要求；硬约束仍由程序执行 |
| 长篇报告生成 | 在 decision 模式下替换为 Jev 分类 |
| 依赖报告字段的护栏 | 适配为直接读取上下文和分类结果 |
| 从报告抽取信号 | 增加直接保存决策的路径 |
| 下单、仓位计算与交易账本 | 作为未来消费信号的独立功能 |

报告模式可以继续保留，新增 decision 模式；两种模式共享数据与指标层。是否保留原报告入口是兼容性选择，不影响本次核心设计。

## 4. 分类的语义

建议第一版使用 buy / sell / hold 三类，但分类集合属于接口设计选择：

- buy：建议增加股票敞口。
- sell：建议减少已有持仓；若采用仅做多模式，不代表建立空头。
- hold：维持当前状态，空仓时表示继续等待。

分类必须说明“对什么时长、什么持仓状态、什么交易假设作判断”。相同股票的短线方向和长期配置结论可能不同，不能只问一个无时间范围的“买还是卖”。

决策配置至少包括 horizon、execution_assumption、cost_assumption 和 position_mode，具体取值待需求收敛。若用户不提供账户信息，应明确标记为研究信号或假设持仓，不能声称已经校验真实账户的可执行性。

第一版只问一个动作分类题即可。趋势、新闻影响、基本面质量等分项分类是可选扩展，不必先建设多 Agent 或多轮推理。

## 5. 最小模块接口

以下为建议接口，不是对上游现有函数名的断言：

```python
build_decision_context(symbol, as_of, config, position_context)
    -> AnalysisContext

jev_classifier.classify(context, decision_config)
    -> ModelDecision

apply_decision_guards(context, model_decision, position_context)
    -> DecisionSignal

save_decision(signal, context_reference)
```

AnalysisContext 应复用 AIStock 已组织好的数据，避免再建设一套重复的数据采集流程。完整快照用于审计，传给 Jev 的输入可做有规则的裁剪，但必须保留缺失状态、数据时点与关键风险。

Jev 适配器屏蔽供应商请求与响应格式，负责枚举、概率、超时和错误处理。程序生成业务字段与原因码，不要求模型生成完整业务 JSON 或长解释。

官方提供 Python SDK / HTTP 接口和 Choice 类型，可作为接入基础；实施时锁定版本并验证真实返回合同。[TypeSafe Quick start](https://docs.typesafe.ai/introduction/quickstart)

## 6. 决策输出

建议业务对象如下，数字仅为格式示例：

```json
{
  "symbol": "600519.SH",
  "model_action": "buy",
  "final_action": "buy",
  "status": "accepted",
  "action_probabilities": {
    "buy": 0.76,
    "sell": 0.08,
    "hold": 0.16
  },
  "reason_codes": [],
  "context_id": "ctx_example",
  "decision_config_id": "config_example",
  "execution_mode": "signal_only"
}
```

实际记录还需包含 as_of、created_at、valid_until、模型实际版本、问题版本、规则版本与原始响应引用。决策配置引用必须能够还原判断周期和交易假设。

model_action 保留 Jev 的原始判断；final_action 表示护栏处理后的信号。例如数据过期可将 buy 阻断为 hold，并记录 STALE_DATA。

模型主动 hold、规则阻断和接口失败必须可区分。模型失败时 model_action 与概率为 null，不伪造“模型决定观望”。缺失或无效概率不补成 100% 确信。

动作概率不是交易盈利胜率；confidence 也来自概率分布，不能算作另一份独立依据。[TypeSafe Confidence](https://docs.typesafe.ai/confidence)

## 7. 最小开发步骤与验收

| 阶段 | 工作 | 验收 |
| --- | --- | --- |
| 1：确认上游接入点 | 固定 AIStock 提交，核对许可证、上下文构建和报告生成调用边界 | 找到可绕过报告直接获取数据与指标的路径 |
| 2：建立决策输入 | 复用采集和指标，定义 AnalysisContext 与决策配置 | 输入能表达多源信息、缺失状态、时点与持仓假设 |
| 3：接入 Jev 分类 | 构建动作问题，增加适配器与响应校验 | 对同一分析上下文直接输出合法分类及概率，无报告依赖 |
| 4：适配护栏与保存 | 迁移必要护栏，保存原始与最终动作及版本 | 可追查动作变更；失败、超时和数据缺失不伪装正常判断 |
| 5：提供单股决策入口 | CLI 或接口接收股票代码及配置，返回 DecisionSignal | 单股多源分析到分类输出完整跑通 |

重点测试：上下文数据未被错误丢弃、时间范围一致、三类动作合法、概率响应有效、护栏覆盖可追溯、模型超时与失败语义正确。

功能验收关注是否可靠地完成“分析输入 → 分类决策”。决策能否改善交易表现属于后续效果验证，应在统一执行与成本假设下比较技术基准和 Jev，并进行前瞻记录；功能跑通本身不证明预测有效。

## 8. 本地源码核验与具体接入位置

已定位两个项目：

- AIStock：`/Users/hyx/Documents/workspace/AI-Stock`。
- Jev 参考：`/Users/hyx/Documents/workspace/jev-trading/reference`。

AIStock 本地 HEAD 为 `405c93e6d2a6b3e523f2eadc237c85f07735d675`。工作区存在未提交修改，包括 single_stock_research.py；本次结论基于当前工作区读取，不声称是纯净提交的结果。本次未修改两个参考项目的业务代码。根 LICENSE 为 MIT，实际抽取代码时保留版权与许可声明，并核对所用依赖的许可证。

### 已核对的调用链

```text
src/strategy_kernels/single_stock_research.py: run
  → src/services/analysis_service.py: AnalysisService.analyze_stock
  → src/core/pipeline.py: StockAnalysisPipeline.process_single_stock
  → analyze_stock
      → 数据采集、技术计算、增强上下文
      → _build_legacy_analysis_artifacts
      → _build_analysis_context_pack_outputs
      → self.analyzer.analyze(...)  ← 普通模式的报告生成边界
      → 结构、阶段与市场护栏
      → save_analysis_history
      → _extract_decision_signal_after_history_save
```

Agent 模式另有 `_analyze_with_agent` 分支，不能仅替换普通模式的 analyzer 就声称覆盖全部入口。建议 decision 模式显式选择直接分类路径，复用采集逻辑，避免意外进入原 Agent 报告生成流程。

### 最小改造清单

| 位置 | 已确认现状 | 建议改动 |
| --- | --- | --- |
| `src/core/pipeline.py`，约 693–755 行 | 增强上下文后调用 analyzer 生成报告 | 保留采集过程，在模型调用前选择 report / decision 分支 |
| `src/services/analysis_context_builder.py`，约 60–117 行 | PipelineAnalysisArtifacts 与 AnalysisContextBuilder 组装已有数据 | 复用 artifacts 构建 Jev 输入，不把 builder 当采集服务 |
| `src/core/pipeline.py`，约 2892 行 | 内部构建 pack，但只返回 summary 和 overview | 暴露原始 pack 供决策使用，保持报告模式兼容 |
| `src/core/pipeline.py`，约 799–838 行 | 护栏修改 AnalysisResult 及相关报告字段 | 提取可用于 DecisionSignal 的政策逻辑，不伪造报告对象 |
| `src/services/decision_signal_extractor.py`，约 201 行 | 从 AnalysisResult 生成 payload，再调用 DecisionSignalService.create_signal | 核对服务 schema 后直接构建分类信号 payload，绕过报告提取 |
| `src/services/analysis_service.py`，约 50–161 行 | 创建流水线、处理 ReportType 并构建报告响应 | 增加清晰的决策入口/模式；返回决策合同 |
| `reference/src/model.ts` | Model.decide 封装 Jev，但问题是盘口 buy/sell 二选一 | 借鉴适配接口；重写股票分析问题与三类动作合同 |

### 输入完整性的两个细节

1. 当前 pack 的 daily_bars 块主要包含 today / yesterday，不是完整历史 K 线序列。技术指标来自此前的历史计算；若 Jev 需要观察完整价格路径，应显式增加裁剪后的历史窗口。
2. 普通流程把 daily_market_context 和 market_structure_context 放入 enhanced_context；pack 当前没有对应的独立顶层块。构建 Jev 输入时应逐项映射这些信息，不能仅序列化 pack 就假定全部分析输入已经保留。

本节为实现前的源码核验记录。现已新增 context_only 采集出口和独立决策保存路径，并完成真实行情采集及离线分类闭环；具体实现、测试范围和未验证项以 [开发记录](implementation.md) 为准。

## 9. 尚需收敛的产品选择

1. 在 AIStock 内部增加 decision 模式，还是在当前项目中适配其模块；两者都优先共享原采集与指标实现。
2. 分类动作、评估周期与交易假设。
3. 是否提供持仓上下文，以及第一版保留哪些可选数据源。

推荐优先选择改动最少的接入方式：共享 AIStock 数据与指标，在原报告生成边界增加 Jev 决策出口；不预先要求重建独立交易后端。
