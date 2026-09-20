import pytest

from jev_trading.collection_options import configure_environment, pipeline_class, mark_disabled, validate_options


def test_collection_overrides_only_explicit_options(monkeypatch):
    monkeypatch.setenv("ENABLE_CHIP_DISTRIBUTION", "true")
    monkeypatch.setenv("ENABLE_REALTIME_QUOTE", "true")
    monkeypatch.setenv("REALTIME_SOURCE_PRIORITY", "efinance")
    configure_environment({"quote": False, "realtimeSources": ["akshare_sina", "tencent"]})
    import os
    assert os.environ["ENABLE_CHIP_DISTRIBUTION"] == "true"
    assert os.environ["ENABLE_REALTIME_QUOTE"] == "false"
    assert os.environ["REALTIME_SOURCE_PRIORITY"] == "akshare_sina,tencent"


def test_disabled_news_skips_fresh_social_and_persisted_sources():
    class Pipeline:
        def __init__(self):
            self.search_service = object()
            self.social_sentiment_service = object()

        def _load_persisted_intelligence_context(self, **kwargs):
            raise AssertionError("persisted news must not be loaded")

    disabled = pipeline_class(Pipeline, {"news": False})()
    assert disabled.search_service is None
    assert disabled.social_sentiment_service is None
    assert disabled._load_persisted_intelligence_context(code="AAPL") is None
    assert pipeline_class(Pipeline, {}) is Pipeline


def test_disabled_data_is_explicit_and_core_checks_remain(context, config, now):
    from datetime import timedelta
    from jev_trading.contracts import ContextSnapshot
    from jev_trading.policy import precheck, quality_warnings
    snapshot = mark_disabled(context.model_dump(mode="json"), {"quote": False, "news": False})
    updated = ContextSnapshot.model_validate(snapshot)
    assert updated.pack["blocks"]["news"]["items"] == {}
    assert "DATA_NEWS_DISABLED" in quality_warnings(updated)
    config.execution_assumption = "immediate"
    assert "LIVE_QUOTE_UNAVAILABLE" in precheck(updated, config, now, now + timedelta(minutes=5))


@pytest.mark.parametrize("value", [[], {"news": "false"}, {"quote": 1}, {"realtimeSources": []}, {"realtimeSources": ["tencent", "tencent"]}, {"unknown": True}])
def test_invalid_collection_options(value):
    with pytest.raises(ValueError):
        validate_options(value)
