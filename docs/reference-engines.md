# 兼容实现与来源说明

本文介绍外部参考实现及其原有部署命令；它们不是本项目的调用方式名称。本项目统一使用 `backend=local`。项目源码与许可证归各自作者所有，使用或分发时保留相应许可声明。

## 源码解读

这份实现以用户本地的两个 checkout 为依据：

- `githubnext/localjev`：`3f23e36e1a3bff46c7e83e8e3781d3512bc82021`。
- `ekzhang/openjev-sglang`：`604664a22b2cf44c6cc499e503092ae4e3c24c03`。

### LocalJev：生成式概率桥接

`src/engine.ts` 把状态和分类问题组织为提示，调用 OpenAI-compatible Chat Completions，要求模型生成概率向量。随后检查完整 JSON、归一化概率、选择最大值，并计算基于熵的 confidence。`src/server.ts` 将结果包装成 Jev 的 `answers` 格式。

因此，当前 LocalJev **不是读取 logits 的实现**。它的优点是可以连接普通的本地聊天推理服务；输出的概率是模型生成的数值，不能等同于模型候选标签的条件概率。其默认配置使用 oMLX 上的 `diffusiongemma-26B-A4B-it-4bit`。上游默认对格式错误输出最多纠正重试两次；本项目不自动重试请求，但无法把上游内部重试说成零次推理。

### OpenJev SGLang：标签 logprobs

`src/openjev/prompts.py` 使用原生聊天模板并禁用 thinking，将选项映射到验证过的单 token 标签。`backend.py` 请求：

```json
{
  "sampling_params": { "max_new_tokens": 1 },
  "token_ids_logprob": ["实际标签 token ID，由上游 tokenizer 确定"],
  "logprob_start_len": -1
}
```

此片段仅解释关键字段，不是可直接提交的完整 SGLang 请求。采样出的 token 被忽略，真正使用的是候选标签的 logprobs。`scoring.py` 做稳定归一化：

```text
w_i = exp((logprob_i - max(logprobs)) / temperature)
p_i = w_i / sum(w)
choice = argmax(p)
confidence = 1 - H(p) / log(number_of_options)
```

它会先执行一次公共前缀缓存预热，再为每个问题做一次单 token 读取，即 N 个问题对应 N+1 次调用。三分类的概率条件化于给定标签集合，受提示词、标签顺序和温度影响，尚不能解释为盈利胜率或经过校准的判断正确率。

默认 profile 是 `Qwen/Qwen3.6-35B-A3B`，权重源为 NVIDIA 的 NVFP4 checkpoint。当前上游配置针对 B200 和 SGLang 0.5.19，包含 CUDA 与硬件相关参数。不能承诺相同配置可在 Apple Silicon 或任意显卡上运行。

## 接入路线 A：LocalJev + 本地模型服务

### 1. 下载并启动本地模型

先在你的本地推理运行器（例如该项目参考的 oMLX）中下载并加载其支持的模型，确认 OpenAI-compatible 服务可用。模型下载、访问许可、量化格式和硬件需求由模型与运行器决定；本项目不捆绑权重，也不自动下载数十 GB 文件。

LocalJev 参考配置的上游服务是 `http://127.0.0.1:8000`，模型名是 `diffusiongemma-26B-A4B-it-4bit`。请使用运行器实际列出的模型 ID，不要仅修改名称却不加载对应权重。

若上游没有鉴权，可以检查：

```sh
curl http://127.0.0.1:8000/v1/models
```

启用鉴权时按运行器要求携带本地密钥。普通聊天服务不能直接作为本项目的 Jev 兼容后端，需要下一步的 LocalJev 桥接。

### 2. 启动 LocalJev

已有 checkout 时直接进入其目录；否则：

```sh
git clone https://github.com/githubnext/localjev.git
cd localjev
bun install --frozen-lockfile
cp .env.example .env
```

在 **LocalJev 自己的 `.env`** 中设置：

```dotenv
LOCALJEV_UPSTREAM=http://127.0.0.1:8000
LOCALJEV_UPSTREAM_MODEL=diffusiongemma-26B-A4B-it-4bit
LOCALJEV_UPSTREAM_API_KEY=
LOCALJEV_HOST=127.0.0.1
LOCALJEV_PORT=8080
# 如需禁止上游格式纠正重试：
LOCALJEV_MALFORMED_RETRIES=0
# 可选：保护 LocalJev 的接口
LOCALJEV_API_KEY=
```

启动与检查：

```sh
bun run start
# 另一个终端
curl http://127.0.0.1:8080/ready
```

### 3. 配置 Jev Trading

在 **本项目的 `.env`** 中设置：

```dotenv
JEV_BACKEND=local
JEV_LOCAL_ENGINE=generated
JEV_LOCAL_BASE_URL=http://127.0.0.1:8080
JEV_LOCAL_MODEL=jev-latest
JEV_LOCAL_LOGPROBS_TIMEOUT_SECONDS=180
# 若 LocalJev 配置了 LOCALJEV_API_KEY，这里填写相同值
JEV_LOCAL_API_KEY=
# 可选审计标签：填写实际加载的模型及权重版本
JEV_LOCAL_MODEL_ID=diffusiongemma-26B-A4B-it-4bit
JEV_LOCAL_MODEL_REVISION=
```

`JEV_LOCAL_MODEL` 是兼容 API 接受的模型名/别名，不会自动加载模型；`JEV_LOCAL_MODEL_ID` 是调用方声明的实际权重名称，用于留痕，不会改变上游部署。

## 接入路线 B：OpenJev SGLang + 本地权重

### 1. 准备支持默认 profile 的 GPU 环境

在符合上游要求的 GPU 主机/容器上准备 SGLang 0.5.19。项目的 `uv sync` 只安装 API、工具和测试，不安装 GPU 推理运行时。模型权重由 SGLang 启动过程获取并加载；tokenizer 使用固定 revision 的 Hugging Face snapshot。首次启动可能下载较大的权重并编译/捕获 CUDA kernels。

本指南走用户自己的 GPU 部署路径，不执行上游的 Modal 公网部署命令。不修改 SGLang 默认模型、量化格式和硬件参数时，应使用其支持的 B200 环境。

```sh
git clone https://github.com/ekzhang/openjev-sglang.git
cd openjev-sglang
uv sync

# /path/to/sglang/bin/python 必须属于已安装 SGLang 的 GPU 环境
uv run openjev serve --host 127.0.0.1 --port 8000 \
  --sglang-python /path/to/sglang/bin/python
```

如果已有匹配模型和 tokenizer revision 的 SGLang 服务：

```sh
uv run openjev serve --host 127.0.0.1 --port 8000 \
  --connect http://127.0.0.1:30000
```

上游要求 selected-token logprobs、足够的上下文长度和匹配的模型/tokenizer。更换权重时需要确认单 token 标签、模型模板和 profile 都适配，不能将任意聊天模型端口直接替代。

```sh
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/v1/models
```

启动器本身监听 loopback。若 GPU 在你控制的另一台主机，可使用 SSH 本地转发，将 Jev 兼容 API 转到本机端口；本项目当前不接受任意远程后端 URL。

### 2. 配置 Jev Trading

```dotenv
JEV_BACKEND=local
JEV_LOCAL_ENGINE=logprobs
JEV_LOCAL_BASE_URL=http://127.0.0.1:8000
JEV_LOCAL_MODEL=jev-latest
JEV_LOCAL_LOGPROBS_TIMEOUT_SECONDS=180
# 若上游设置 OPENJEV_API_KEY，这里填写对应密钥
JEV_LOCAL_API_KEY=
JEV_LOCAL_MODEL_ID=Qwen/Qwen3.6-35B-A3B
JEV_LOCAL_MODEL_REVISION=
```

OpenJev 的响应 `model` 可能仍是请求别名；本项目保持原始响应不变，另将 `x-openjev-model` 响应头记录为 `inference.reported_model`。配置的模型 ID/revision 仅为声明值，不能替代对权重的核验。

## 检查并调用

本项目提供连接检查，不执行分类推理或下载模型：

```sh
bun run backend:check
bun run doctor
bun run serve
```

`backend:check` 请求 LocalJev 的 `/ready` 或 OpenJev 的 `/health`。`doctor` 和 `/v1/health` 仍是本项目的配置检查；`ready: true` 不代表远端模型已加载或可推理。网页设置也可选择后端、填写本地 URL、密钥和超时；**已保存的网页设置优先于 `.env`**。

运行服务后，调用方式与云端完全相同：

```sh
curl -sS http://127.0.0.1:3000/v1/decisions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: local-stock-request-001' \
  -d '{"symbol":"600519","position":"flat","waitSeconds":0}'
```

随后按 `links.self` 轮询。不要传 `mode: demo` 来验证本地推理：demo 始终使用固定响应，与选定后端无关。

超时范围 1–300 秒，云端默认 30，本地默认 180；数据收集最多 240 秒。示例 Python 客户端最多轮询 600 秒。即时执行的信号有效期仍为 120 秒，即使本地模型最终返回，也可能因过期被拒绝。

### 审计字段

以下是新增字段的示意，并非已完成真实模型测试的记录：

```json
{
  "model_source": "local",
  "inference": {
    "backend": "local",
    "probability_method": "label_logprobs",
    "endpoint": "http://127.0.0.1:8000/v1/systemone",
    "declared_model": "Qwen/Qwen3.6-35B-A3B",
    "declared_revision": null,
    "reported_model": "Qwen/Qwen3.6-35B-A3B"
  }
}
```

LocalJev 的 `probability_method` 为 `generated_probabilities`，云端为 `provider_reported`，演示为 `recorded`。后端地址和声明的模型版本参与 Python 决策身份计算。HTTP 幂等标识仍代表同一次提交：切换后端后若需要新分析，必须生成新标识。

本地地址只允许 loopback 的 HTTP(S) 根地址（也接受 `/v1` 并规范化），拒绝嵌入凭据、查询参数和重定向。云端与本地密钥分开，原始输入、响应和后端来源一起保留。本项目不把云端密钥发送到本地服务，也不因本地失败而自动调用云端。

## 高级 Python CLI

CLI 支持相同后端类型，环境变量需显式导出（CLI 不自动加载 `.env` 或网页设置）：

```sh
export JEV_BACKEND=local
export JEV_LOCAL_ENGINE=logprobs
export JEV_LOCAL_BASE_URL=http://127.0.0.1:8000
uv run jev-trading decide --context data/600519-context.json \
  --config examples/decision-config.json
```

可用 `--backend`、`--local-base-url`、`--model` 覆盖选择。CLI 的请求超时由配置 JSON 的 `request_timeout_seconds` 决定，而非 Web 的 `JEV_MODEL_TIMEOUT_SECONDS`。

## 本轮验证边界

已验证云端兼容性、本地 HTTP 协议、密钥隔离、禁止重定向与云端回退、超时取消、无效概率拒绝、Python 桥接与审计来源。测试使用本地测试服务和固定响应，不代表已加载真实权重或测得股票预测优势。本机本轮没有下载大模型，也未运行 B200 上的真实推理。

## 两个调用入口

**网页：** 打开「连接设置」，在「推理后端」选择 Jev 云端或本地决策引擎，并在本地设置中选择概率计算方式，保存后分析。两种本地计算方式分别保留地址、密钥、模型及超时，切换时恢复对应配置。

**HTTP：** 在请求 JSON 中传 `backend`，不改变网页的默认选择。服务端会按本次后端检查环境，并冻结执行所用配置。

```sh
python3 examples/http_client.py --symbol 600519 --position flat --backend local --local-engine logprobs
curl -sS http://127.0.0.1:3000/v1/backends
```

若希望同时配置两个本地服务，可以先在网页中分别保存，或使用各自的环境变量：

```dotenv
JEV_LOCAL_GENERATED_BASE_URL=http://127.0.0.1:8080
JEV_LOCAL_GENERATED_API_KEY=
JEV_LOCAL_GENERATED_MODEL=jev-latest
JEV_LOCAL_GENERATED_TIMEOUT_SECONDS=180
JEV_LOCAL_LOGPROBS_BASE_URL=http://127.0.0.1:8000
JEV_LOCAL_LOGPROBS_API_KEY=
JEV_LOCAL_LOGPROBS_MODEL=jev-latest
JEV_LOCAL_LOGPROBS_TIMEOUT_SECONDS=180
```

这两组还接受 `_MODEL_ID`、`_MODEL_REVISION` 审计标签。优先级为：已保存的对应后端配置 → 对应后端环境变量 → 当前默认后端的旧通用配置 → 内置默认值。通用 `JEV_LOCAL_*` 配置只用于默认本地计算方式，不会跨方式复制密钥。

本节的独立配置适用于 HTTP/网页服务；高级 Python CLI 仍使用前文的通用 `JEV_LOCAL_*` 变量。下载权重和加载模型仍在推理运行器中完成；上述 HTTP 调用不会自动下载模型或启动 GPU 进程。
