"""Private stdin/stdout bridge for the Bun workbench; no secrets cross this boundary."""
import asyncio
import json
import sys
from datetime import timedelta
from pathlib import Path

from .contracts import ContextSnapshot, DecisionConfig, InferenceMetadata, digest, utcnow
from .model import ModelFailure, build_request
from .policy import precheck
from .service import decide
from .storage import DecisionStore


class SuppliedClassifier:
    def __init__(self, payload):
        self.payload = payload
        self.inference = InferenceMetadata.model_validate(
            {"backend": "recorded", "probability_method": "recorded"} if payload.get("demo")
            else payload.get("inference") or {"backend": "jev", "probability_method": "provider_reported"})
        self.source = self.inference.backend
        self.model = payload["model"]
        self.cache_identity = digest({"model": self.model, "inference": self.inference.model_dump()})
        self.external_latency_ms = payload.get("latency_ms")

    async def classify(self, request, timeout):
        if self.payload.get("error_code"):
            raise ModelFailure(self.payload["error_code"])
        return self.payload["response"]


def main():
    payload = json.load(sys.stdin)
    context = ContextSnapshot.model_validate(payload["context"])
    config = DecisionConfig.model_validate(payload["config"])
    if payload["operation"] == "prepare":
        expires = context.captured_at + timedelta(seconds=config.validity_seconds)
        print(json.dumps({"request": build_request(context, config, payload["model"]),
                          "reasons": precheck(context, config, utcnow(), expires)}, ensure_ascii=False))
        return
    if payload["operation"] != "complete":
        raise ValueError("unknown bridge operation")
    store = DecisionStore(Path(payload["database"]))
    try:
        result = asyncio.run(decide(context, config, SuppliedClassifier(payload), store,
                                    retry_token=payload["job_id"]))
        print(result.model_dump_json())
    finally:
        store.close()


if __name__ == "__main__":
    main()
