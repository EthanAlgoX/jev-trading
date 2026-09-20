#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

run_bun() {
  if command -v bun >/dev/null 2>&1; then
    exec bun "$@"
  else
    exec npx --yes --package=bun@1.4.2 bun "$@"
  fi
}

case "${1:-}" in
  model)
    model_path="${QWEN_MODEL_PATH:-$HOME/.cache/jev-trading/models/Qwen3.5-0.8B-Q8_0/Qwen3.5-0.8B-Q8_0.gguf}"
    [[ -f "$model_path" ]] || { echo "Model missing: $model_path" >&2; exit 1; }
    exec llama-server --model "$model_path" --alias qwen3.5-0.8b-q8 \
      --host 127.0.0.1 --port 8018 --ctx-size 8192 --parallel 1 \
      --n-gpu-layers 99 --jinja --reasoning off
    ;;
  bridge)
    run_bun run examples/local-qwen/label-bridge.ts
    ;;
  trading)
    export JEV_DATA_DIR="$PWD/output/qwen-local-test/data" PORT=3018
    export JEV_BACKEND=local JEV_LOCAL_ENGINE=logprobs
    export JEV_LOCAL_LOGPROBS_BASE_URL=http://127.0.0.1:8089
    export JEV_LOCAL_LOGPROBS_MODEL=jev-latest JEV_LOCAL_LOGPROBS_API_KEY=''
    export JEV_LOCAL_LOGPROBS_MODEL_ID=Qwen/Qwen3.5-0.8B
    export JEV_LOCAL_LOGPROBS_MODEL_REVISION=unsloth-6ab461498e2023f6e3c1baea90a8f0fe38ab64d0-Q8_0
    export JEV_LOCAL_LOGPROBS_TIMEOUT_SECONDS=180
    export TYPESAFE_AI_API_KEY='' TYPESAFE_API_KEY=''
    run_bun run app/server.ts
    ;;
  smoke)
    run_bun run examples/local-qwen/smoke.ts
    ;;
  *) echo "Usage: bash examples/local-qwen/start.sh {model|bridge|trading|smoke}" >&2; exit 2 ;;
esac
