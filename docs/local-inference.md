# 本地决策引擎

网页和 HTTP API 均提供两种调用方式：`jev`（Jev 云端，默认）与 `local`（本地决策引擎）。本地决策引擎是 Jev Trading 对本地推理服务的统一接入层名称，不是新训练的模型，也不是把参考项目重命名后重新发布。

## 两种概率计算方式

| `localEngine` | 如何计算 | 使用条件 |
| --- | --- | --- |
| `logprobs`（本地默认） | 读取候选标签 token 的 logprobs，再做 softmax | 运行器支持标签分数读取，标签与 tokenizer 匹配 |
| `generated` | 模型生成概率 JSON，再校验与归一化 | 聊天模型与概率生成适配器 |

两种方式共用 `POST /v1/systemone` 协议，但统计意义不同。生成的数字不是读取到的 logits；标签概率也不是股票盈利胜率。结果的 `inference.probability_method` 会记录真实配置的方法，配置必须与实际服务一致，应用不能从普通 JSON 响应自动证明其内部算法。

## 部署与调用

1. 下载适配运行器的开放权重模型并加载。模型许可、量化格式及硬件需求取决于所选模型和运行器。
2. 启动兼容的分类服务。普通 `/v1/chat/completions` 地址不能直接代替 `/v1/systemone`。
3. 在网页「连接设置」选择「本地决策引擎」，选择概率计算方式，填写服务地址和模型别名并保存。也可通过环境变量配置。
4. 运行 `bun run backend:check` 检查就绪端点，再提交真实请求验证分类。

可运行的外部实现、下载和启动命令见 [兼容实现与来源说明](reference-engines.md)。本项目不捆绑权重，也未完成真实权重推理验证；已验证协议、路由、风控和审计链路。

```dotenv
# 保持默认优先云端，同时预先配置本地服务
JEV_BACKEND=jev
JEV_LOCAL_ENGINE=logprobs
JEV_LOCAL_BASE_URL=http://127.0.0.1:8000
JEV_LOCAL_MODEL=jev-latest
JEV_LOCAL_API_KEY=
```

```sh
bun run serve
curl -sS http://127.0.0.1:3000/v1/decisions \
  -H 'Content-Type: application/json' \
  -d '{"symbol":"600519","position":"flat","backend":"local","waitSeconds":0}'
```

响应可能为异步任务；按 `links.self` 轮询，完整规则见 [HTTP API](http-api.md)。省略 `backend` 使用服务端默认；显式 `jev` 使用云端。单次请求不修改网页默认值。本地失败不会回退云端。`mode: demo` 使用固定响应，不验证真实模型。

## 高级配置

`localEngine` 可按请求指定 `generated` 或 `logprobs`。两个方法各自保存地址、鉴权、模型声明和超时，避免切换时串用。网页保存的配置优先于环境变量。

| 环境变量 | 含义 |
| --- | --- |
| `JEV_LOCAL_ENGINE` | 默认本地方法，默认 `logprobs` |
| `JEV_LOCAL_BASE_URL` | 默认本地方法的兼容 API 根地址；仅允许本机 HTTP(S) |
| `JEV_LOCAL_MODEL` | 兼容服务接受的模型别名，默认 `jev-latest` |
| `JEV_LOCAL_API_KEY` | 本地服务鉴权，可留空；不复用云端密钥 |
| `JEV_LOCAL_MODEL_ID` / `JEV_LOCAL_MODEL_REVISION` | 声明的权重与版本，作为审计信息，不会下载或切换权重 |
| `JEV_LOCAL_GENERATED_*` / `JEV_LOCAL_LOGPROBS_*` | 各方法独立的 `BASE_URL`、`API_KEY`、`MODEL`、`MODEL_ID`、`MODEL_REVISION`、`TIMEOUT_SECONDS` |

未指定地址时，`generated` 默认 8080，`logprobs` 默认 8000。就绪探测分别使用 `/ready`（status=ready）与 `/health`（status=ok）。本地推理默认超时 180 秒，允许 1–300 秒。云端默认 30 秒。

```json
{"symbol":"AAPL","position":"flat","backend":"local","localEngine":"generated"}
```

GET `/v1/backends` 只列出 `jev`、`local`，并提供本地方法的可用配置。新结果的 `model_source` 为 `local`，方法区别保留在 `inference.probability_method`。原始模型响应、模型声明、输入及风控理由均保留。

## 旧配置迁移

旧版使用参考项目名称的配置会映射到 `local` 和对应方法，保存时写入新格式。历史审计记录不改写；原始模型名称、兼容响应头和必要来源说明保留。旧环境变量仍兼容读取，新部署使用本页变量。参考实现的比较及许可证来源仅放在技术参考页，不再作为产品调用方式。
