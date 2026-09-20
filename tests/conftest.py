from datetime import datetime, timezone

import pytest

from jev_trading.contracts import ContextSnapshot, DecisionConfig, Position


@pytest.fixture
def now():
    return datetime(2026, 9, 18, 8, tzinfo=timezone.utc)


@pytest.fixture
def context(now):
    return ContextSnapshot(symbol="600519", captured_at=now, pack={
        "subject": {"code": "600519"},
        "phase": {"phase": "postmarket", "effective_daily_bar_date": "2026-09-18",
                  "is_market_open_now": False},
        "blocks": {
            "quote": {"status": "available", "items": {"price": {"value": 100}}},
            "daily_bars": {"status": "available", "metadata": {"date": "2026-09-18"},
                           "items": {"today": {"value": {"close": 100}}}},
            "technical": {"status": "available", "items": {"trend_result": {"value": {"score": 65}}}},
            "news": {"status": "missing", "items": {}},
        },
    }, enhanced_context={"daily_market_context": {"risk_tags": ["neutral"]},
                         "market_structure_context": {"regime": "range"}},
        history=[{"date": "2026-09-18", "close": 100}], market_is_conservative=False)


@pytest.fixture
def config():
    return DecisionConfig(horizon="5 trading days", execution_assumption="next_session_open",
                          cost_assumption="0.3% round trip example", position=Position(state="flat"))


@pytest.fixture
def response():
    return {"model": "jev-test-version", "answers": {"action": {
        "type": "choice", "choice": "buy", "probabilities": {"buy": .76, "sell": .08, "hold": .16},
        "confidence": .5}}, "usage": {"input_tokens": 100, "output_tokens": 12}}
