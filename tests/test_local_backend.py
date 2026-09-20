import asyncio
import httpx
import pytest

from jev_trading.model import LocalClassifier, ModelFailure
from jev_trading.service import decide
from jev_trading.storage import DecisionStore


@pytest.mark.parametrize("backend,method", [("generated", "generated_probabilities"), ("logprobs", "label_logprobs")])
def test_local_classifier_records_source_and_uses_only_local_credentials(tmp_path, context, config, response, backend, method):
    def handle(request):
        assert str(request.url) == "http://127.0.0.1:8080/v1/systemone"
        assert request.headers.get("authorization") == "Bearer local-test"
        return httpx.Response(200, json=response, headers={"x-openjev-model": "actual-model"})
    classifier = LocalClassifier(backend, "http://127.0.0.1:8080/v1", api_key="local-test",
                                declared_model="configured-model", declared_revision="rev-a", transport=httpx.MockTransport(handle))
    store = DecisionStore(tmp_path / "audit.db")
    try:
        signal = asyncio.run(decide(context, config, classifier, store, clock=lambda: context.captured_at))
        assert signal.status == "accepted"
        assert signal.model_source == "local"
        assert signal.inference.probability_method == method
        assert signal.inference.declared_revision == "rev-a"
        if backend == "logprobs":
            assert signal.inference.reported_model == "actual-model"
        assert store.inspect(signal.decision_id)["raw_response"] == response
    finally:
        store.close()


def test_local_backend_identity_includes_endpoint_and_model_revision():
    a = LocalClassifier("generated", "http://localhost:8080", declared_revision="a")
    b = LocalClassifier("generated", "http://localhost:8080", declared_revision="b")
    c = LocalClassifier("logprobs", "http://localhost:8080", declared_revision="a")
    d = LocalClassifier("generated", "http://localhost:8081", declared_revision="a")
    assert len({x.cache_identity for x in [a, b, c, d]}) == 4
    for url in ["https://example.com", "http://secret@localhost", "http://localhost/?token=secret", "file:///tmp/model"]:
        with pytest.raises(ValueError):
            LocalClassifier("generated", url)


def test_local_http_failure_never_retries_or_falls_back():
    calls = []
    def handle(request):
        calls.append(str(request.url))
        assert "authorization" not in request.headers
        return httpx.Response(503)
    classifier = LocalClassifier("generated", "http://localhost:8080", transport=httpx.MockTransport(handle))
    with pytest.raises(ModelFailure, match="MODEL_HTTP_503"):
        asyncio.run(classifier.classify({}, 1))
    assert len(calls) == 1
