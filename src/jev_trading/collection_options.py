"""Small, dependency-free adapter shared with the isolated AIStock worker."""
import os

SOURCES = {"tencent", "akshare_sina", "efinance", "akshare_em"}


def validate_options(options):
    if not isinstance(options, dict) or set(options) - {"quote", "chip", "news", "realtimeSources"}:
        raise ValueError("Unknown collection options")
    for key in ("quote", "chip", "news"):
        if key in options and type(options[key]) is not bool:
            raise ValueError(f"{key} must be boolean")
    if "realtimeSources" in options:
        sources = options["realtimeSources"]
        if (not isinstance(sources, list) or not 1 <= len(sources) <= 4
                or any(not isinstance(s, str) or s not in SOURCES for s in sources)
                or len(set(sources)) != len(sources)):
            raise ValueError("Invalid realtime sources")
    return options


def configure_environment(options):
    validate_options(options)
    for key, env in (("quote", "ENABLE_REALTIME_QUOTE"), ("chip", "ENABLE_CHIP_DISTRIBUTION")):
        if key in options:
            os.environ[env] = str(options[key]).lower()
    if "realtimeSources" in options:
        os.environ["REALTIME_SOURCE_PRIORITY"] = ",".join(options["realtimeSources"])


def pipeline_class(base, options):
    """Skip both fresh news searches and previously persisted news evidence."""
    if options.get("news") is not False:
        return base

    class WithoutNews(base):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.search_service = None
            self.social_sentiment_service = None

        def _load_persisted_intelligence_context(self, *args, **kwargs):
            return None

    return WithoutNews


def mark_disabled(snapshot, options):
    for key in ("quote", "chip", "news"):
        if options.get(key) is False:
            snapshot["pack"]["blocks"][key] = {
                "status": "disabled", "items": {}, "metadata": {"reason": "disabled_by_user"}}
    snapshot.setdefault("provenance", {})["collection_options"] = options
    return snapshot
