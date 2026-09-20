# Jev Trading

复用 AIStock 的多源单股分析，将末端的报告生成替换为 Jev `buy / sell / hold` 分类。本文为高级命令行接口说明。日常使用请从 [网页工作台](../README.md) 开始，所有入口均只输出信号。

```text
股票代码 → AIStock 行情 / 基本面 / 新闻 / 筹码 / 技术指标
        → 分析快照 → Jev 分类 → 数据与动作护栏 → DecisionSignal + SQLite
```

## 安装

需要 Python 3.12+ 和 uv：

```sh
uv sync
uv run jev-trading --help
```

AIStock 使用自己的依赖环境，分类服务在独立环境运行。参考项目 `reference/` 不参与运行，不需要 Bun 或链上钱包。

## 无密钥体验

```sh
mkdir -p data
uv run python examples/make_demo_context.py > data/demo-context.json
uv run jev-trading decide \
  --context data/demo-context.json \
  --config examples/decision-config.json \
  --recorded-response examples/recorded-response.json
```

此命令使用合成行情与固定示例响应，输出 `model_source: recorded`，验证输入、护栏、保存和查询闭环，不代表 Jev 的真实判断。

## 接入本地 AIStock

当前本地 AIStock 已加入 `context_only` 扩展；换用新 checkout 时先检查并应用配套补丁：

```sh
git -C /path/to/AI-Stock apply --check /path/to/jev-trading/patches/aistock-context-only.patch
git -C /path/to/AI-Stock apply /path/to/jev-trading/patches/aistock-context-only.patch
```

已应用的 checkout 不要重复应用。补丁保留原报告模式，仅增加采集出口；源码版本变化导致检查失败时，应重新核对边界，不强制应用。AIStock 依赖安装依其项目说明。

```sh
export AISTOCK_PATH=/path/to/AI-Stock
export AISTOCK_PYTHON="$AISTOCK_PATH/.venv/bin/python"
uv run jev-trading collect --symbol 600519 --output data/600519-context.json
```

采集会加载 AIStock 根目录的 `.env` 配置，但数据库强制使用本项目 `data/aistock.db`，避免写入已有研究账本。数据提供商可能降级；每个块的状态、来源、缺失信息都保留。大盘上下文只读取已有结果，不触发另一轮报告模型调用；新采集数据库可能没有该上下文，会明确标记未知。

采集超时会终止子进程组，日志在 `data/collection.log`。如果使用其他路径，可以传入 `--aistock-path`、`--aistock-python`、`--data-dir`。环境变量应显式导出，主 CLI 不自动加载 `.env`。

## 真实 Jev 分类

通过安全的环境配置设置 `TYPESAFE_AI_API_KEY`，模型由 `JEV_MODEL_ID` 或 `--model` 指定（兼容 `TYPESAFE_API_KEY`、`JEV_MODEL`）。不要把密钥放入决策配置或快照。

```sh
export JEV_MODEL=jev-latest
uv run jev-trading decide \
  --context data/600519-context.json \
  --config examples/decision-config.json
```

也可一次完成采集与分类：

```sh
uv run jev-trading decide --symbol 600519 --config examples/decision-config.json
```

示例配置的 5 日周期、下一开盘和成本假设均是可修改的示例。决策配置必须明确提供周期、执行假设和成本；持仓可为 `flat / long / unknown`。未知持仓下的买卖建议会被程序阻断。可附加 `can_buy / can_sell` 调用方约束，但服务没有连接真实账户，也不校验真实可用资金或交易所全部规则。

请求使用官方 `POST /v1/systemone` 的 Choice 合同，单次推理，支持取消的硬超时，无自动重试。[TypeSafe Quick start](https://docs.typesafe.ai/introduction/quickstart)

## 输出、保存与查询

- `model_action`：原始模型分类；失败或未调用时为 null。
- `final_action`：程序校验后的动作，阻断时为 hold。
- `status`：accepted / blocked / skipped / error / expired。
- `action_probabilities`：原始三类概率，不能解释为盈利胜率。
- `reason_codes / policy_trace`：阻断或失败依据。
- `valid_until`：从采集开始计算的信号有效期，不是承诺下单时间。
- `model_source / requested_model / resolved_model`：重放标识及模型版本。

SQLite 默认写入 `data/decisions.db`，包含完整快照、精确请求、原始响应和最终信号。无报告数据库依赖。

```sh
uv run jev-trading show <decision_id>
```

相同快照、配置、问题和模型请求只运行一次。重复调用返回原记录，若已过期则返回过期视图；`show` 保留原始证据。变动模型别名不会自动刷新旧快照决策，重新推理须使用显式 `--retry-token <唯一值>`，或指定固定模型版本。

进程意外退出的 running 记录不会自动重发付费请求；检查后用 retry-token 创建新尝试。此机制防止重复调用，不承诺多账户交易调度。

CLI 正常/阻断返回 0，输入或配置错误返回 1，模型错误、数据跳过或过期返回 2。脚本必须读取 `status` 与 `final_action`，不能只用退出码决定交易。

## 验证与边界

```sh
uv run pytest -q
uv run python -m compileall -q src tests examples
```

实现了数据时效与核心输入检查、保守市场限制、持仓方向及调用方买卖权限、概率校验、超时和迟到结果处理。保守市场判断复用 AIStock 的输入分类函数；原报告中依赖价格建议、评分、解释文字的所有护栏尚未完整迁移，不能宣称与原报告风控完全等价。

当前没有订单执行、自动止损、仓位计算、收益回测。历史输入不保证 point-in-time 完整性，不能把历史重放当作无未来信息的回测。真实交易前需要独立执行规则、账户检查与效果验证。

实现细节及本次验证结果见 [开发记录](implementation.md)。

## 本地模型

CLI 可使用 `--backend local`，用 `--local-engine generated` 或 `--local-engine logprobs` 选择概率计算方式、`--local-base-url http://127.0.0.1:8080`，也可显式导出 `JEV_BACKEND`、`JEV_LOCAL_BASE_URL`、`JEV_LOCAL_MODEL` 和可选的 `JEV_LOCAL_API_KEY`。本地推理不使用云端密钥。`--model` 优先于当前后端的模型环境变量。

调用方还可配置 `JEV_LOCAL_MODEL_ID`、`JEV_LOCAL_MODEL_REVISION` 用于审计区分。超时仍由决策配置中的 `request_timeout_seconds` 控制；CLI 不读取网页设置。完整部署与概率来源说明见 [本地推理指南](local-inference.md)。
