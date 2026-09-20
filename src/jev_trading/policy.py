from datetime import datetime

from .contracts import ContextSnapshot, DecisionConfig, ModelDecision

BAD_CORE = {"missing", "fetch_failed", "stale", "not_supported"}
KNOWN_STATUSES = BAD_CORE | {"available", "partial", "estimated", "fallback"}


def precheck(context: ContextSnapshot, config: DecisionConfig, now: datetime, expires: datetime) -> list[str]:
    reasons = []
    if context.captured_at > now:
        reasons.append("FUTURE_CONTEXT")
    if now >= expires:
        reasons.append("CONTEXT_EXPIRED")
    blocks = context.pack["blocks"]
    for name in ("daily_bars", "technical"):
        block = blocks.get(name, {})
        status = block.get("status", "missing")
        if status in BAD_CORE or status not in KNOWN_STATUSES or not block.get("items"):
            reasons.append(f"UNUSABLE_{name.upper()}")
    phase = context.pack.get("phase") or {}
    target = phase.get("effective_daily_bar_date")
    bars = blocks.get("daily_bars", {})
    bar_date = bars.get("metadata", {}).get("date")
    if not target or not bar_date:
        reasons.append("UNKNOWN_BAR_DATE")
    elif str(bar_date)[:10] != str(target)[:10]:
        reasons.append("BAR_DATE_MISMATCH")
    if config.execution_assumption == "immediate":
        if phase.get("is_market_open_now") is not True:
            reasons.append("MARKET_NOT_OPEN")
        quote = blocks.get("quote", {})
        if quote.get("status") != "available":
            reasons.append("LIVE_QUOTE_UNAVAILABLE")
        try:
            quote_time = datetime.fromisoformat(str(quote.get("timestamp", "")).replace("Z", "+00:00"))
            if quote_time.tzinfo is None:
                raise ValueError("unknown timezone")
            age = (now - quote_time).total_seconds()
            if age < 0 or age > config.max_quote_age_seconds:
                reasons.append("STALE_QUOTE")
        except (TypeError, ValueError):
            reasons.append("UNKNOWN_QUOTE_TIME")
    return reasons


def apply_policy(context: ContextSnapshot, config: DecisionConfig, model: ModelDecision) -> list[str]:
    reasons = []
    action, position = model.action, config.position
    if action != "hold" and position.state == "unknown":
        reasons.append("HOLDING_CONTEXT_REQUIRED")
    if action == "sell":
        if position.state == "flat":
            reasons.append("NO_LONG_POSITION")
        if position.can_sell is False:
            reasons.append("SELL_NOT_ALLOWED")
    if action == "buy":
        if position.can_buy is False:
            reasons.append("BUY_NOT_ALLOWED")
        if context.market_is_conservative is True:
            reasons.append("CONSERVATIVE_MARKET")
        for name in ("daily_bars", "technical"):
            if context.pack["blocks"].get(name, {}).get("status") != "available":
                reasons.append(f"DEGRADED_{name.upper()}")
    return reasons


def quality_warnings(context: ContextSnapshot) -> list[str]:
    warnings = []
    for name, block in context.pack["blocks"].items():
        if block.get("status") != "available":
            warnings.append(f"DATA_{name.upper()}_{block.get('status', 'missing').upper()}")
    if context.market_is_conservative is None:
        warnings.append("MARKET_RISK_UNKNOWN")
    warnings.append("SIGNAL_ONLY_NOT_EXECUTION_VALIDATED")
    return warnings
