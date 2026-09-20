"""Create clearly synthetic, current-time input for offline CLI demonstration."""
import json
from datetime import datetime, timezone

now = datetime.now(timezone.utc)
day = now.date().isoformat()
print(json.dumps({
    "schema_version": "1", "symbol": "DEMO", "captured_at": now.isoformat(),
    "provenance": {"source": "synthetic_demo_not_market_data"},
    "pack": {
        "subject": {"code": "DEMO"},
        "phase": {"phase": "postmarket", "effective_daily_bar_date": day, "is_market_open_now": False},
        "blocks": {
            "daily_bars": {"status": "available", "metadata": {"date": day},
                           "items": {"today": {"value": {"close": 100}}}},
            "technical": {"status": "available", "items": {"trend_result": {"value": {"signal_score": 65}}}},
            "news": {"status": "missing", "items": {}},
            "fundamentals": {"status": "missing", "items": {}},
            "chip": {"status": "not_supported", "items": {}},
        },
    },
}, ensure_ascii=False, indent=2))
