# 自行部署的本地 HTTP 决策服务

本项目提供可在用户电脑运行的服务程序，不提供托管 API。客户端请求本机服务；真实模式下服务仍需访问用户配置的外部行情源和 Jev API，不是离线模型。

## 部署与启动

安装 Bun 和 uv，在项目目录运行：

```sh
bun install --frozen-lockfile
cp .env.example .env
# 真实分析时编辑 TYPESAFE_AI_API_KEY；演示无需密钥
bun run serve
```

`serve` 自动准备 Python 依赖，不打开浏览器；进程运行期间可访问 `http://127.0.0.1:3000`。Ctrl+C 停止服务。可用 `PORT=3010 bun run serve` 修改端口。AIStock 的依赖和 context_only 入口按 [README](../README.md) 准备。

服务默认仅监听本机，当前不提供远程监听或多用户托管。Jev 密钥在服务端配置，调用方无需每次传入。网页只是同一服务的辅助配置和查看界面。

## 最小调用

```sh
curl -sS http://127.0.0.1:3000/v1/decisions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-request-001' \
  -d '{"mode":"demo","position":"flat"}'
```

真实分析（先配置服务端密钥及 AIStock）：

```sh
curl -sS http://127.0.0.1:3000/v1/decisions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: aapl-request-001' \
  -d '{"symbol":"AAPL","position":"flat","horizon":5}'
```

示例中的请求标识应由调用方为每次新分析生成。网络重试复用原标识；同一标识配不同参数返回 409。省略标识时服务自动生成，但客户端网络故障后无法依此安全重试。标识允许 8–100 位字母、数字、连字符。

## 接口约定

| 接口 | 用途 |
| --- | --- |
| `GET /v1/backends` | 默认后端及各后端配置状态，不返回密钥 |
| `GET /v1/health` | 服务存活、真实/演示就绪状态、缺失配置和活动任务 |
| `POST /v1/decisions` | 创建决策，短时间内完成则直接返回结果 |
| `GET /v1/decisions/{request_id}` | 查询处理状态及决策 |
| `GET /v1/decisions/{request_id}/evidence` | 导出原始上下文、请求、响应和审计信号 |

请求为 JSON 对象，未知字段直接拒绝：

| 字段 | 约束与默认值 |
| --- | --- |
| `symbol` | 真实模式必填；如 600519、AAPL、HK00700 |
| `position` | 必填：flat 空仓、long 已持有 |
| `localEngine` | 可选：generated / logprobs；选择本地概率计算方法，省略使用已保存配置 |
| `backend` | 本次请求后端：jev / local；省略使用服务端默认，不修改默认值 |
| `mode` | live（默认）或 demo；不自动降级成演示 |
| `horizon` | 1–250 个交易日，默认 5 |
| `execution` | next_session_open（默认）或 immediate |
| `costPercent` | 往返成本与滑点百分比，0–10，默认 0.3；仅分析假设 |
| `instructions` | 策略说明，最多 8000 字符，默认空字符串 |
| `waitSeconds` | 0–25，默认 25；0 表示立即返回任务 |

POST 在等待期内完成返回 HTTP 200，否则返回 HTTP 202、Location 查询地址和 Retry-After: 2。202 不代表最终决策。连接断开或等待结束不会取消分析。查询使用 GET，不会重新调用模型。

所有正常响应包含 `api_version`、`request_id`、`state`、`mode`、`progress`、`message`、`decision`、`error` 和 `links`。进行中 `decision` 为 null；state 为 queued / collecting / evaluating / validating / done / failed。

完成后 `decision` 直接包含 `model_action`、`final_action`、`status`、`action_probabilities`、`reason_codes`、`valid_until`、`model_source` 等字段。`state=done` 仅表示处理结束，还必须检查 `decision.status`；模型失败或数据不足不会伪装成正常观望。过期查询返回 hold/expired，审计导出仍保留原始记录。演示的 model_source 为 recorded。

HTTP 请求错误使用 `{"error":{"code":"...","message":"..."}}`：400 参数错误、403 来源/内容类型不允许、404 不存在、409 忙碌或幂等冲突、503 环境未就绪。有效任务的处理失败保存在任务响应中（state=failed）；模型错误保存在 decision.status=error。单实例一次处理一个任务，不提供排队；409 BUSY 后可稍后用原幂等标识重试。

## Python 调用与恢复

无需安装 Python HTTP 库：

```sh
python3 examples/http_client.py --demo
python3 examples/http_client.py --symbol 600519 --position flat
python3 examples/http_client.py --request-id <已有请求ID>
```

[客户端示例](../examples/http_client.py) 封装提交与轮询，输出完整 JSON。通过 `result['decision']['final_action']` 读取最终动作，同时检查状态、有效期和模式。分类信号不是成交指令，服务不访问交易账户或下单。

服务重启后已完成记录保留，运行中任务标为失败，不自动重发付费推理。再次分析时使用新幂等标识。

## 切换云端与本地模型

服务端支持 `JEV_BACKEND=jev|local`。本地模式不要求 Jev 云端密钥，请求体和 URL 不变；请求可通过 `backend` 选择已配置的后端；不接受调用方传入任意后端 URL 或密钥。省略该字段时使用服务端默认值，不因一次请求改变网页选择。部署、下载权重的边界和概率原理见 [本地推理指南](local-inference.md)。

`model_source` 现在还可能是 `local`。新增 `inference` 对象记录后端、概率来源、地址、声明的模型 ID/revision，以及可用的上游实际模型响应头。历史记录可能没有该字段。`generated` 的概率来自生成的 JSON，`logprobs` 的概率来自标签分数，不应混为同类统计结果。`mode: demo` 始终使用固定响应。

`GET /v1/health` 额外返回 `inference_backend` 与 `probability_method`，仍不执行推理连通性测试；用 `bun run backend:check` 检查本地模型服务的就绪端点。切换后端后使用新的幂等标识发起新分析，复用旧标识仍返回旧任务。

### 按请求选择本地模型

```sh
curl -sS http://127.0.0.1:3000/v1/decisions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: local-stock-002' \
  -d '{"symbol":"600519","position":"flat","backend":"local","waitSeconds":0}'
```

云端请求将 `backend` 改为 `jev`；本地决策引擎使用 `local`。每种后端的模型地址和鉴权仍在服务端配置。响应的 `inference_backend` 表示本次任务实际选择的后端，demo 始终为 recorded。后台执行使用提交时的配置快照。

同一幂等标识改变 `backend` 返回 409；省略 `backend` 的历史请求即使服务默认已变，也返回原任务。要重新分析请使用新标识。
