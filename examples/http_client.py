"""Local HTTP client. No third-party packages. Run: python3 examples/http_client.py --demo"""
import argparse
import json
import time
import sys
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def request(base, path, payload=None, key=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Idempotency-Key"] = key
    data = json.dumps(payload).encode() if payload is not None else None
    try:
        with urlopen(Request(base + path, data=data, headers=headers), timeout=35) as response:
            return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"HTTP {error.code}: {error.read().decode()}") from None


def main():
    parser = argparse.ArgumentParser(description="调用自行部署的 Jev 本地决策服务")
    parser.add_argument("--base-url", default="http://127.0.0.1:3000")
    parser.add_argument("--local-engine", choices=["generated", "logprobs"], help="本地引擎的概率计算方式；省略则使用服务端配置")
    parser.add_argument("--backend", choices=["jev", "local"], help="本次分析使用的后端；省略则使用服务端默认")
    parser.add_argument("--demo", action="store_true")
    parser.add_argument("--symbol", help="股票代码；自带数据时默认使用快照中的代码，否则默认 600519")
    parser.add_argument("--instructions", default="", help="本次策略偏好；非空时覆盖模板")
    parser.add_argument("--strategy-id", help="已保存的策略模板编号")
    parser.add_argument("--context", type=Path, help="自带 ContextSnapshot JSON，跳过 AIStock")
    parser.add_argument("--collection", type=Path, help="采集选项 JSON 文件")
    parser.add_argument("--position", choices=["flat", "long"], default="flat")
    parser.add_argument("--request-id", help="恢复查询已有请求，不创建新分析")
    parser.add_argument("--idempotency-key", default=None, help="重复提交时复用同一个标识")
    args = parser.parse_args()
    if args.context and args.collection:
        parser.error("--context 和 --collection 不能同时使用")
    if args.demo and (args.context or args.collection):
        parser.error("演示不支持自带数据或采集配置")
    context = collection = None
    try:
        if args.context:
            context = json.loads(args.context.read_text(encoding="utf-8"))
            if not isinstance(context, dict):
                raise ValueError("context 必须是 JSON 对象")
        if args.collection:
            collection = json.loads(args.collection.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        parser.error(str(error))
    base = args.base_url.rstrip("/")
    key = args.idempotency_key or str(uuid.uuid4())
    if args.request_id:
        result = request(base, f"/v1/decisions/{args.request_id}")
    else:
        # Print the key before submission so a network failure can be retried safely.
        print(f"Idempotency-Key: {key}", file=sys.stderr)
        result = request(base, "/v1/decisions", {
            "symbol": args.symbol or (context or {}).get("symbol") or "600519", "position": args.position,
            "mode": "demo" if args.demo else "live", "waitSeconds": 0,
            "instructions": args.instructions,
            **({"strategyId": args.strategy_id} if args.strategy_id else {}),
            **({"context": context} if args.context else {}),
            **({"collection": collection} if args.collection else {}),
            **({"backend": args.backend} if args.backend else {}),
            **({"localEngine": args.local_engine} if args.local_engine else {}),
        }, key)
    print(f"Request ID: {result['request_id']}", file=sys.stderr)
    deadline = time.monotonic() + 600
    while result["state"] not in {"done", "failed"}:
        if time.monotonic() >= deadline:
            raise RuntimeError(f"等待超时，任务可能仍在运行；用 --request-id {result['request_id']} 恢复查询。")
        time.sleep(2)
        result = request(base, result["links"]["self"])
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result["state"] == "failed" or result["decision"]["status"] in {"error", "expired", "skipped"}:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
