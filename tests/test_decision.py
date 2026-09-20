import asyncio
import json
from datetime import timedelta

import httpx
import pytest
from pydantic import ValidationError

from jev_trading.contracts import ContextSnapshot, Position
from jev_trading.model import JevClassifier, ModelFailure, RecordedClassifier, build_request, parse_response
from jev_trading.service import decide
from jev_trading.storage import BusyRun, DecisionStore


def run(tmp_path, context, config, response, now, classifier=None, **kwargs):
    store = DecisionStore(tmp_path / "signals.db")
    result = asyncio.run(decide(context, config, classifier or RecordedClassifier(response), store,
                                clock=lambda: now, **kwargs))
    evidence = store.inspect(result.decision_id)
    store.close()
    return result, evidence


def test_full_decision_preserves_input_and_response(tmp_path, context, config, response, now):
    result, evidence = run(tmp_path, context, config, response, now)
    assert (result.model_action, result.final_action, result.status) == ("buy", "buy", "accepted")
    assert result.model_source == "recorded"
    assert evidence["raw_response"] == response
    assert evidence["context"]["history"] == context.history
    state = json.loads(evidence["request"]["state"])
    assert state["analysis"]["enhanced_context"] == context.enhanced_context
    assert state["analysis"]["pack"]["blocks"]["news"]["status"] == "missing"
    assert "DATA_NEWS_MISSING" in result.warnings


@pytest.mark.parametrize("condition,reason", [
    ("conservative", "CONSERVATIVE_MARKET"), ("cash", "BUY_NOT_ALLOWED"),
    ("unknown", "HOLDING_CONTEXT_REQUIRED"), ("partial", "DEGRADED_TECHNICAL"),
])
def test_buy_constraints_preserve_model(tmp_path, context, config, response, now, condition, reason):
    if condition == "conservative":
        context.market_is_conservative = True
    if condition == "cash":
        config.position.can_buy = False
    if condition == "unknown":
        config.position.state = "unknown"
    if condition == "partial":
        context.pack["blocks"]["technical"]["status"] = "partial"
    result, _ = run(tmp_path, context, config, response, now)
    assert result.status == "blocked" and result.final_action == "hold" and result.model_action == "buy"
    assert reason in result.reason_codes
    assert result.action_probabilities == response["answers"]["action"]["probabilities"]


def test_sell_requires_holding(tmp_path, context, config, response, now):
    response["answers"]["action"].update(choice="sell", probabilities={"buy": .1, "sell": .8, "hold": .1})
    result, _ = run(tmp_path, context, config, response, now)
    assert result.reason_codes == ["NO_LONG_POSITION"]
    config.position = Position(state="long")
    result, _ = run(tmp_path, context, config, response, now)
    assert result.final_action == "sell"


@pytest.mark.parametrize("condition,reason", [
    ("stale", "UNUSABLE_TECHNICAL"), ("date", "BAR_DATE_MISMATCH"),
    ("closed", "MARKET_NOT_OPEN"), ("future", "FUTURE_CONTEXT"),
    ("old", "CONTEXT_EXPIRED"), ("missing_date", "UNKNOWN_BAR_DATE"),
])
def test_precheck_never_calls_model(tmp_path, context, config, response, now, condition, reason):
    if condition == "stale":
        context.pack["blocks"]["technical"]["status"] = "stale"
    elif condition == "date":
        context.pack["blocks"]["daily_bars"]["metadata"]["date"] = "2026-09-17"
    elif condition == "missing_date":
        del context.pack["blocks"]["daily_bars"]["metadata"]["date"]
    elif condition == "closed":
        config.execution_assumption = "immediate"
    elif condition == "future":
        context.captured_at += timedelta(seconds=1)
    elif condition == "old":
        context.captured_at -= timedelta(days=2)
    class Never(RecordedClassifier):
        async def classify(self, request, timeout):
            pytest.fail("precheck should have blocked model")
    result, evidence = run(tmp_path, context, config, response, now, Never(response))
    assert reason in result.reason_codes
    assert result.model_action is None and result.action_probabilities is None
    assert evidence["raw_response"] is None


@pytest.mark.parametrize("probabilities", [
    {"buy": 1}, {"buy": .9, "sell": .9, "hold": 0},
    {"buy": -1, "sell": 1, "hold": 1}, {"buy": "0.8", "sell": .1, "hold": .1},
    {"buy": True, "sell": 0, "hold": 0}, {"buy": float("nan"), "sell": 0, "hold": 0},
    {"buy": .1, "sell": .8, "hold": .1},
])
def test_rejects_invalid_probabilities(response, probabilities):
    response["answers"]["action"]["probabilities"] = probabilities
    with pytest.raises(ModelFailure, match="INVALID_MODEL_RESPONSE"):
        parse_response(response)


def test_invalid_response_stored_as_error(tmp_path, context, config, response, now):
    del response["answers"]["action"]["probabilities"]
    result, evidence = run(tmp_path, context, config, response, now)
    assert result.status == "error" and result.model_action is None
    assert evidence["raw_response"] == response


def test_live_http_contract(tmp_path, context, config, response, now):
    def handler(request):
        assert request.url == "https://api.typesafe.ai/v1/systemone"
        assert request.headers["Authorization"] == "Bearer test-secret"
        body = json.loads(request.content)
        assert set(body["questions"]["action"]["criteria"]) == {"buy", "sell", "hold"}
        assert isinstance(body["state"], str)
        return httpx.Response(200, json=response)
    classifier = JevClassifier("test-secret", "jev-requested", httpx.MockTransport(handler))
    result, evidence = run(tmp_path, context, config, response, now, classifier)
    assert result.model_source == "jev" and result.resolved_model == "jev-test-version"
    assert "test-secret" not in json.dumps(evidence)


def test_hard_timeout_is_persisted(tmp_path, context, config, response, now):
    async def slow(request):
        await asyncio.sleep(1)
        return httpx.Response(200, json=response)
    config.request_timeout_seconds = .01
    result, _ = run(tmp_path, context, config, response, now,
                    JevClassifier("test", "jev", httpx.MockTransport(slow)))
    assert result.status == "error" and result.reason_codes == ["MODEL_TIMEOUT"]


def test_late_response_archived_not_accepted(tmp_path, context, config, response, now):
    store = DecisionStore(tmp_path / "signals.db")
    times = iter([now, now + timedelta(hours=2)])
    result = asyncio.run(decide(context, config, RecordedClassifier(response), store, clock=lambda: next(times)))
    assert result.status == "expired" and result.final_action == "hold" and result.model_action == "buy"
    assert store.inspect(result.decision_id)["raw_response"] == response
    store.close()


def test_idempotency_and_expired_retrieval(tmp_path, context, config, response, now):
    first, _ = run(tmp_path, context, config, response, now)
    second, _ = run(tmp_path, context, config, response, now)
    assert first == second
    expired, evidence = run(tmp_path, context, config, response, now + timedelta(hours=2))
    assert expired.status == "expired" and expired.final_action == "hold"
    assert evidence["signal"]["status"] == "accepted"  # immutable original
    retry, _ = run(tmp_path, context, config, response, now, retry_token="retry-1")
    assert retry.decision_id != first.decision_id


def test_in_progress_claim_is_not_reexecuted(tmp_path, context, config):
    store = DecisionStore(tmp_path / "signals.db")
    request = build_request(context, config, "jev")
    store.claim("same", context, request)
    with pytest.raises(BusyRun):
        store.claim("same", context, request)
    store.close()


def test_rejects_symbol_mismatch_and_naive_time(context):
    data = context.model_dump(mode="json")
    data["symbol"] = "OTHER"
    with pytest.raises(ValidationError):
        ContextSnapshot.model_validate(data)

    data["symbol"] = context.symbol
    data["captured_at"] = "2026-09-18T08:00:00"
    with pytest.raises(ValidationError):
        ContextSnapshot.model_validate(data)


def test_provider_rounded_probabilities_are_preserved(tmp_path, context, config, response, now):
    response["answers"]["action"]["probabilities"] = {"buy": .34, "sell": .34, "hold": .33}
    result, evidence = run(tmp_path, context, config, response, now)
    assert result.status == "accepted"
    assert result.action_probabilities == {"buy": .34, "sell": .34, "hold": .33}
    assert "PROBABILITIES_ROUNDED" in result.warnings
    assert evidence["raw_response"] == response



def test_hold_is_distinct_from_failure(tmp_path, context, config, response, now):
    response["answers"]["action"].update(choice="hold", probabilities={"buy": .1, "sell": .1, "hold": .8})
    result, _ = run(tmp_path, context, config, response, now)
    assert result.status == "accepted" and result.model_action == result.final_action == "hold"
    assert result.reason_codes == []


@pytest.mark.parametrize("kind,reason", [("http", "MODEL_HTTP_401"), ("json", "INVALID_MODEL_RESPONSE")])
def test_http_errors_are_not_model_hold(tmp_path, context, config, response, now, kind, reason):
    def handler(request):
        return httpx.Response(401 if kind == "http" else 200, text="not json: private-provider-detail")
    result, evidence = run(tmp_path, context, config, response, now,
                           JevClassifier("secret", "jev", httpx.MockTransport(handler)))
    assert result.status == "error" and result.model_action is None
    assert result.action_probabilities is None and result.reason_codes == [reason]
    assert "private-provider-detail" not in json.dumps(evidence)


def test_immediate_signal_requires_timestamped_fresh_quote(tmp_path, context, config, response, now):
    config.execution_assumption = "immediate"
    context.pack["phase"]["is_market_open_now"] = True
    result, _ = run(tmp_path, context, config, response, now)
    assert "UNKNOWN_QUOTE_TIME" in result.reason_codes
    context.pack["blocks"]["quote"]["timestamp"] = (now - timedelta(minutes=5)).isoformat()
    result, _ = run(tmp_path, context, config, response, now)
    assert "STALE_QUOTE" in result.reason_codes
    context.pack["blocks"]["quote"]["timestamp"] = now.isoformat()
    result, _ = run(tmp_path, context, config, response, now)
    assert result.status == "accepted"
