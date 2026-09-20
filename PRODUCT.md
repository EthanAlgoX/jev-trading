# Product
<!-- impeccable:product-schema 1 -->

## Platform
local HTTP service with optional web UI

## Users
希望自行部署并通过 HTTP 输入股票代码、获得结构化决策的用户和程序调用方；网页用于辅助配置和查看。

## Product Purpose
复用 AIStock 多源单股分析与参考 jev-trader 的 Jev SDK，输出买入、卖出或观望。

## Capabilities and Constraints
本地运行，仅输出信号；真实模式需要 AIStock，并可选择 Jev 云端（需密钥）或本地决策引擎（生成式概率 / 标签 logprobs）。演示数据与真实结果必须清楚区分。已有 Python 护栏与 SQLite 审计记录保留。原项目有 Bun 服务与推送模式，可作为应用入口参考。

## Evidence on Hand
reference/src/model.ts 是 SDK 调用参考；reference/web 提供现有视觉系统。用户已经要求自主开发与更易上手，沿用这些事实，不重复产品访谈。

## Open Decisions
默认单股、5 日分析周期与下一交易日开盘是可修改的产品默认值，不是用户已验证策略。用户明确要求本地部署和 HTTP 调用作为主要交付方式，不提供托管服务。

## Product Principles
让首次体验不依赖密钥；配置问题给出具体恢复方式；先展示最终动作，再解释模型动作与程序调整；不把信号展示成订单或收益。
