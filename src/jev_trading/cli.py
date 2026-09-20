import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from .collector import collect
from .contracts import ContextSnapshot, DecisionConfig
from .model import JevClassifier, LocalClassifier, RecordedClassifier
from .service import decide
from .storage import BusyRun, DecisionStore


def add_collection_options(parser):
    parser.add_argument("--aistock-path", type=Path, default=Path(os.getenv("AISTOCK_PATH", "../AI-Stock")))
    parser.add_argument("--aistock-python", type=Path,
                        default=Path(os.getenv("AISTOCK_PYTHON", "../AI-Stock/.venv/bin/python")))
    parser.add_argument("--data-dir", type=Path, default=Path("data"))
    parser.add_argument("--collection-timeout", type=float, default=300)


def load_context(args):
    if getattr(args, "context", None):
        return ContextSnapshot.model_validate_json(args.context.read_text(encoding="utf-8"))
    return collect(args.symbol, args.aistock_path, args.aistock_python, args.data_dir, args.collection_timeout)


def main() -> int:
    parser = argparse.ArgumentParser(description="AIStock 多源单股分析 → Jev 分类决策（仅信号）")
    sub = parser.add_subparsers(dest="command", required=True)
    collector = sub.add_parser("collect", help="只采集数据与指标，不生成报告或调用 Jev")
    collector.add_argument("--symbol", required=True)
    collector.add_argument("--output", type=Path, required=True)
    add_collection_options(collector)
    decision = sub.add_parser("decide", help="从分析数据直接输出 buy/sell/hold")
    source = decision.add_mutually_exclusive_group(required=True)
    source.add_argument("--context", type=Path)
    source.add_argument("--symbol")
    decision.add_argument("--config", type=Path, required=True)
    decision.add_argument("--recorded-response", type=Path, help="离线响应重放，输出明确标记 recorded")
    decision.add_argument("--model", help="模型名称；未指定时使用当前后端环境配置")
    decision.add_argument("--backend", choices=["jev", "local"], default={"localjev": "local", "openjev_sglang": "local"}.get(os.getenv("JEV_BACKEND", "jev"), os.getenv("JEV_BACKEND", "jev")))
    decision.add_argument("--local-engine", choices=["generated", "logprobs"], default=os.getenv("JEV_LOCAL_ENGINE") or ("generated" if os.getenv("JEV_BACKEND") == "localjev" else "logprobs"))
    decision.add_argument("--local-base-url", default=os.getenv("JEV_LOCAL_BASE_URL"))
    decision.add_argument("--db", type=Path, default=Path("data/decisions.db"))
    decision.add_argument("--retry-token", default="", help="显式创建新的尝试，保留旧记录")
    add_collection_options(decision)
    show = sub.add_parser("show", help="查看信号、输入、原始响应和问题版本")
    show.add_argument("decision_id")
    show.add_argument("--db", type=Path, default=Path("data/decisions.db"))
    args = parser.parse_args()
    try:
        if args.command == "collect":
            context = load_context(args)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(context.model_dump_json(indent=2), encoding="utf-8")
            print(json.dumps({"context_id": context.context_id, "path": str(args.output)}, ensure_ascii=False))
            return 0
        if args.command == "show":
            store = DecisionStore(args.db)
            try:
                print(json.dumps(store.inspect(args.decision_id), ensure_ascii=False, indent=2))
            finally:
                store.close()
            return 0
        config = DecisionConfig.model_validate_json(args.config.read_text(encoding="utf-8"))
        if args.recorded_response:
            classifier = RecordedClassifier(json.loads(args.recorded_response.read_text(encoding="utf-8")))
        elif args.backend == "local":
            classifier = LocalClassifier(args.local_engine,
                args.local_base_url or ("http://127.0.0.1:8080" if args.local_engine == "generated" else "http://127.0.0.1:8000"),
                args.model or os.getenv("JEV_LOCAL_MODEL", "jev-latest"), os.getenv("JEV_LOCAL_API_KEY", ""),
                os.getenv("JEV_LOCAL_MODEL_ID"), os.getenv("JEV_LOCAL_MODEL_REVISION"))
        else:
            # Fail on missing credentials before spending time collecting market data.
            classifier = JevClassifier(os.getenv("TYPESAFE_AI_API_KEY") or os.getenv("TYPESAFE_API_KEY", ""), args.model or os.getenv("JEV_MODEL_ID") or os.getenv("JEV_MODEL", "jev-latest"))
        context = load_context(args)
        store = DecisionStore(args.db)
        try:
            result = asyncio.run(decide(context, config, classifier, store, args.retry_token))
        finally:
            store.close()
        print(result.model_dump_json(indent=2))
        return 2 if result.status in {"error", "skipped", "expired"} else 0
    except (ValueError, OSError, RuntimeError, KeyError, BusyRun) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
