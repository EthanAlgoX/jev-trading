# 自定义策略与数据

股票代码按请求指定，每次分析一只；服务仍一次处理一个任务。你可以保存自己的决策提示词、控制部分 AIStock 采集路径，或完全使用自己的数据快照。

## 在网页里使用

1. 展开「调整分析假设」，填写策略偏好和模板名称，点击「另存为模板」。
2. 下次从「策略模板」选择它。可以临时编辑提示词，也可以点击「更新模板」保存为新版本。
3. 展开「选择采集数据」，设置实时行情、筹码、新闻开关，以及实时行情来源顺序。仅对这次真实分析生效；未设置的选项沿用 AIStock 配置。
4. 选择股票、持仓与周期后提交。结果显示策略名和版本，导出的依据保留当时的模板与实际提示词。

删除模板不会删除历史分析。模板变更也不会修改已经提交的任务。演示使用固定数据和响应，不能验证策略效果；采集选项在演示模式下禁用。

## 策略模板 API

列表：`GET /v1/strategies`。

新建：

```sh
curl -sS http://127.0.0.1:3000/v1/strategies \
  -H 'Content-Type: application/json' \
  -d '{"name":"趋势与成交量","instructions":"重点考虑中期趋势和成交量，关键证据不足时观望。"}'
```

返回 `id`、`name`、`instructions`、`version` 和 `updatedAt`。同一接口提交 `id`、`name`、`instructions` 更新模板，版本递增。名称 1–80 字符，提示词 1–8000 字符。

删除：`DELETE /v1/strategies/{id}`，请求仍带 `Content-Type: application/json`。网页与 API 共享本机 `data/strategies.sqlite` 中的模板。

分析请求通过 `strategyId` 引用模板：

```json
{
  "symbol": "AAPL",
  "position": "flat",
  "strategyId": "替换为模板返回的 id",
  "instructions": "本次额外关注财报事件，证据不足时观望。"
}
```

非空 `instructions` **整体覆盖**模板文本，不是追加；空字符串或省略时使用模板，没有模板时使用默认偏好。固定的三类动作规则与程序校验不可通过策略文本关闭。这是决策 prompt，不是 AIStock 长篇研究报告的 prompt。

同一个幂等标识重试会返回原任务，即使模板后来更新或删除。要使用新版本分析，提交新的幂等标识。

## 每次请求选择采集方式

在 `POST /v1/decisions` 中增加 `collection`：

```json
{
  "symbol": "600519",
  "position": "flat",
  "collection": {
    "quote": true,
    "chip": false,
    "news": false,
    "realtimeSources": ["tencent", "akshare_sina", "efinance", "akshare_em"]
  }
}
```

| 选项 | 含义 |
| --- | --- |
| `quote` | 覆盖 AIStock 的实时行情开关 |
| `chip` | 覆盖筹码采集开关 |
| `news: false` | 跳过本次新闻搜索、社交舆情获取，以及已保存的个股新闻上下文 |
| `news: true` 或省略 | 使用 AIStock 已配置的新闻能力，不自动配置服务或密钥 |
| `realtimeSources` | 上述四种来源的非空、不重复列表，按顺序传给 AIStock 实时行情优先级配置 |

开关影响采集过程，不只是从模型输入中隐藏数据。显式关闭的模块标为 `disabled`，模型和导出记录能区分“用户关闭”与“获取失败”。关闭实时行情时，`immediate` 判断仍会因缺少实时行情而被拦截。

来源优先级主要适用于 AIStock 的 A 股实时行情路径；其他市场可能有独立的路由。它不控制历史行情、基本面或新闻供应商，也不是禁止其他网络访问的白名单。历史行情、技术指标、基本面与大盘背景仍按 AIStock 的原流程处理。数据源密钥仍在 AIStock 中配置，本接口不接受任意供应商地址、密钥或可执行代码。

CLI 采集也支持：

```sh
uv run python -m jev_trading.cli collect --symbol 600519 \
  --collection-options '{"news":false,"chip":false}' \
  --output data/custom-context.json
```

## 自带数据，跳过 AIStock

在真实分析请求中传 `context`，即可直接使用自己的行情或研究数据。此时无需 AIStock 路径或环境，但仍需本项目的 Python 环境和可用模型配置。

`context` 使用项目的 `ContextSnapshot` 结构，包含：

- `schema_version: "1"`、与请求一致的 `symbol`、带时区的 `captured_at`。
- `pack.subject.code` 与股票代码一致。
- `pack.blocks` 中各模块的状态、数据项、元信息。
- 决策所需的 `daily_bars` 与 `technical` 数据；`pack.phase.effective_daily_bar_date` 与日线元信息中的 `date` 必须一致。
- 可选 `enhanced_context`、`history`、`market_is_conservative` 和 `provenance`。

最容易的适配方式是先运行 `collect` 导出实际快照，参照其结构接入自己的供应商。自带数据的真实性、来源和时间由调用方负责提供；不要把旧数据的采集时间改成当前时间。程序仍检查格式、股票一致性、数据状态、有效期及持仓限制，不能通过上传上下文绕过检查。格式错误返回 `400 INVALID_CONTEXT`；格式有效但过期或缺少核心数据时，不调用模型，返回受限结果。

HTTP 客户端支持直接读文件：

```sh
python3 examples/http_client.py --context data/custom-context.json \
  --position flat --backend local \
  --instructions '关注趋势，证据不足时观望。'
```

客户端默认从快照读取股票代码；也可以显式提供 `--symbol`，但必须一致。其他入口：`--strategy-id ID` 引用模板，`--collection options.json` 读取采集配置。`--context` 与 `--collection` 互斥，演示模式不能使用这两个参数。

直接调用 HTTP 时，把快照对象放入请求的 `context` 字段。请求体总大小上限为 1 MiB，不接受文件路径或 URL 来替代快照。`GET /v1/health` 的 `supplied_context_ready` 表示默认模型后端的自带数据配置是否就绪，仅检查配置，不探测模型连接。

## 记录与验证边界

完整依据的 `context.provenance.decision_input` 记录输入类型（`aistock` / `supplied` / `demo`）、采集选项、模板版本和是否提供覆盖文本。最终实际提示词位于模型请求的 `state.decision_config.strategy_instructions`（`state` 是 JSON 字符串）。AIStock 采集还记录 `collection_options`。

自动化测试覆盖模板版本、幂等重试、数据校验、关闭新闻的适配逻辑及模拟本地模型的端到端请求。真实供应商可用性和真实模型的策略效果仍需在你的配置下验证；模板管理本身不提供策略收益评估。
