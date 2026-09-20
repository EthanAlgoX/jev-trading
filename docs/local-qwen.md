# 在本机运行 Qwen3.5 小模型

本实验已在 Apple M1 Pro、16 GB 内存上完成真实推理：Qwen3.5-0.8B 可以回答普通问题，也可以通过标签概率适配器接入 Jev Trading。它只验证本地调用链路，不代表模型具备可靠的投资判断能力。

调用顺序：Jev Trading（3018）→ 股票分类适配器（8089）→ llama.cpp（8018）→ 本地 GGUF 权重。三个服务只监听本机。

## 1. 准备运行器和权重

先完成项目的常规依赖安装。示例需要 Bash、Bun（也可通过 Node.js 的 npx 运行）和 llama.cpp。本次使用 Homebrew llama.cpp 10450；其他版本的概率接口可能不同。macOS 可运行 `brew install llama.cpp`。

基础模型是 [Qwen/Qwen3.5-0.8B](https://huggingface.co/Qwen/Qwen3.5-0.8B)，下载的是 [Unsloth 的 Q8_0 GGUF 量化版本](https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF)。以下固定下载版本，文件为 811,843,840 字节（约 774 MiB）。本实验只使用文本权重。

```bash
mkdir -p "$HOME/.cache/jev-trading/models/Qwen3.5-0.8B-Q8_0"
curl --fail --location --retry 3 \
  'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/Qwen3.5-0.8B-Q8_0.gguf' \
  -o "$HOME/.cache/jev-trading/models/Qwen3.5-0.8B-Q8_0/Qwen3.5-0.8B-Q8_0.gguf"
shasum -a 256 "$HOME/.cache/jev-trading/models/Qwen3.5-0.8B-Q8_0/Qwen3.5-0.8B-Q8_0.gguf"
```

校验值必须为 `0ad885ffd4bb022fc4f0d33a3308fa108ef8613159d3b3a67e23abca056b7a6c`。已下载且校验通过的文件无需重新下载。

## 2. 启动三个服务

在仓库根目录分别打开三个终端，依次运行：

```bash
# 终端一：等待模型加载完成
bash examples/local-qwen/start.sh model

# 终端二：启动标签概率适配器
bash examples/local-qwen/start.sh bridge

# 终端三：启动独立测试实例
bash examples/local-qwen/start.sh trading
```

打开 <http://127.0.0.1:3018>。测试实例使用 `output/qwen-local-test/data` 保存数据，与默认实例隔离。三个终端各用 Ctrl+C 停止服务；已运行时不要重复启动。模型放在其他位置时，可在第一条命令前设置 `QWEN_MODEL_PATH=/绝对路径/模型.gguf`。

脚本配置 `backend=local`、`localEngine=logprobs`，禁用该测试进程的云端密钥。若此前在测试实例网页保存过连接设置，保存值优先于环境变量，请检查地址为 `http://127.0.0.1:8089`、模型别名为 `jev-latest`。

## 3. 运行真实调用检查

```bash
bash examples/local-qwen/start.sh smoke
```

检查包含普通聊天、两个合成股票情境和缺失技术数据的拦截。股票请求使用 `mode=live` 和显式提供的合成 context，不调用行情采集，也不使用 demo 固定决策。结果和完整证据写入被 Git 忽略的 `output/qwen-local-test/`。脚本会检查真实本地来源、概率总和与缺失数据拦截，失败时返回非零退出码。

2026-09-20 的[原始结果摘要](../examples/local-qwen/validation.json)：

| 检查 | 结果 |
| --- | --- |
| 普通聊天：2+2 | HTTP 200，回答 `4` |
| 普通合成情境 | accepted / hold；buy 8.33%、sell 38.63%、hold 53.04% |
| 风险合成情境 | accepted / hold；buy 7.87%、sell 45.13%、hold 47.00% |
| 缺失技术数据 | skipped / hold，原因 `UNUSABLE_TECHNICAL`，未执行推理 |

两次分类的模型调用耗时分别为 352 ms、274 ms，存在提示缓存影响，不是性能基准。新运行的输出和耗时可能不同。

## 适配范围和限制

[适配器源码](../examples/local-qwen/label-bridge.ts)将 buy、sell、hold 映射为 A、B、C，验证单 token 边界，从 llama.cpp 读取实际标签分数，再在三个标签间归一化。决策取概率最大的标签；相同分数时优先 hold。返回的概率是标签条件概率，不是盈利概率，confidence 也未经校准。

这是实验用的股票三分类适配器，仅支持 `questions.action`、8192 token 上下文和单个并发请求，不是完整的通用 Jev API 服务。它没有实现生产部署所需的完整鉴权、队列和运行管理。

同一次实验还尝试了让模型直接生成概率 JSON，但出现全零概率并被拒绝；增加重试也未获得有意义的分类验证。因此这里仅提供成功验证的标签概率方案，不将 generated 方案描述为可用。两个合成样本也不足以评价金融决策质量。
