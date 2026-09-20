"""Executed in AIStock's Python environment; communicates through a JSON file.

No dependency on the jev_trading package, no credentials in the payload.
"""
import argparse
import hashlib
import inspect
import json
import math
import os
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from enum import Enum
from pathlib import Path


def json_safe(value):
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Enum):
        return json_safe(value.value)
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if hasattr(value, "item"):
        return json_safe(value.item())
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--symbol", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--database", required=True)
    args = parser.parse_args()
    root = Path(args.root).resolve()
    sys.path.insert(0, str(root))
    os.chdir(root)
    # Keep collection writes out of the user's existing research database.
    os.environ["DATABASE_PATH"] = args.database
    from dotenv import load_dotenv
    load_dotenv(root / ".env", override=False)
    from data_provider.base import normalize_stock_code
    from src.core.pipeline import StockAnalysisPipeline
    from src.daily_market_context_guardrail import _is_conservative_context
    from src.services.analysis_context_builder import AnalysisContextBuilder, PipelineAnalysisArtifacts
    from src.utils.sanitize import redact_sensitive_mapping

    if "context_only" not in inspect.signature(StockAnalysisPipeline).parameters:
        raise RuntimeError("AISTOCK_CONTEXT_ONLY_PATCH_REQUIRED")
    started = datetime.now(timezone.utc)
    symbol = normalize_stock_code(args.symbol)
    pipeline = StockAnalysisPipeline(context_only=True, portfolio_context={},
                                     daily_market_context_allow_generate=False)
    artifacts = pipeline.process_single_stock(symbol, current_time=started, single_stock_notify=False)
    if not isinstance(artifacts, PipelineAnalysisArtifacts):
        raise RuntimeError("AISTOCK_COLLECTION_FAILED")
    pack = AnalysisContextBuilder.build(artifacts).to_safe_dict()
    phase = artifacts.phase or {}
    target = phase.get("effective_daily_bar_date")
    history = []
    if target:
        end = date.fromisoformat(str(target)[:10])
        history = [bar.to_dict() for bar in pipeline.db.get_data_range(symbol, end - timedelta(days=120), end)]
        history = sorted(history, key=lambda bar: str(bar.get("date", "")))[-90:]
    market_context = artifacts.enhanced_context.get("daily_market_context")
    head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
    source_paths = ["src/core/pipeline.py", "src/services/analysis_context_builder.py",
                    "src/stock_analyzer.py", "src/daily_market_context_guardrail.py"]
    hashes = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in source_paths}
    snapshot = {
        "schema_version": "1", "symbol": symbol, "captured_at": started.isoformat(),
        "pack": pack, "enhanced_context": artifacts.enhanced_context,
        "history": history,
        "market_is_conservative": _is_conservative_context(market_context) if market_context else None,
        "provenance": {"source": "aistock_context_only", "head": head, "source_hashes": hashes,
                       "collected_at": datetime.now(timezone.utc).isoformat(),
                       "history_note": "stored bars, not guaranteed point-in-time historical data"},
    }
    Path(args.output).write_text(
        json.dumps(json_safe(redact_sensitive_mapping(snapshot)), ensure_ascii=False, allow_nan=False),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
