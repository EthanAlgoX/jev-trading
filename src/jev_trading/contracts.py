from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Action = Literal["buy", "sell", "hold"]
Status = Literal["accepted", "blocked", "skipped", "error", "expired"]


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Position(Contract):
    state: Literal["flat", "long", "unknown"] = "unknown"
    can_buy: bool | None = None
    can_sell: bool | None = None


class DecisionConfig(Contract):
    horizon: str = Field(min_length=1, max_length=500)
    execution_assumption: Literal["next_session_open", "immediate"]
    cost_assumption: str = Field(min_length=1, max_length=1000)
    strategy_instructions: str = Field(default="综合技术面、基本面、新闻及市场环境判断。", max_length=8000)
    position: Position = Field(default_factory=Position)
    validity_seconds: int = Field(default=3600, ge=1, le=604800)
    request_timeout_seconds: float = Field(default=30, gt=0, le=300)
    max_quote_age_seconds: int = Field(default=120, ge=1, le=3600)
    question_version: Literal["stock_action_v1"] = "stock_action_v1"
    policy_version: Literal["signal_policy_v1"] = "signal_policy_v1"

    @field_validator("horizon", "cost_assumption", "strategy_instructions")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value.strip()


class ContextSnapshot(Contract):
    schema_version: Literal["1"] = "1"
    symbol: str = Field(min_length=1)
    captured_at: datetime
    pack: dict[str, Any]
    enhanced_context: dict[str, Any] = Field(default_factory=dict)
    history: list[dict[str, Any]] = Field(default_factory=list)
    provenance: dict[str, Any] = Field(default_factory=dict)
    market_is_conservative: bool | None = None

    @field_validator("captured_at")
    @classmethod
    def timezone_required(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("captured_at must have a timezone")
        return value

    @model_validator(mode="after")
    def validate_pack(self) -> ContextSnapshot:
        subject = self.pack.get("subject")
        if not isinstance(subject, dict) or subject.get("code") != self.symbol:
            raise ValueError("pack subject must match symbol")
        blocks = self.pack.get("blocks")
        if not isinstance(blocks, dict):
            raise ValueError("pack.blocks is required")
        for name, block in blocks.items():
            if not isinstance(block, dict) or not isinstance(block.get("status"), str):
                raise ValueError(f"invalid context block: {name}")
            if not isinstance(block.get("items", {}), dict) or not isinstance(block.get("metadata", {}), dict):
                raise ValueError(f"invalid block items/metadata: {name}")
        if self.pack.get("phase") is not None and not isinstance(self.pack["phase"], dict):
            raise ValueError("invalid phase")
        canonical(self.model_dump(mode="json"))
        return self

    @property
    def context_id(self) -> str:
        return digest(self.model_dump(mode="json"))


class ModelDecision(Contract):
    action: Action
    probabilities: dict[Action, float]
    confidence: float | None = Field(default=None, ge=0, le=1)
    resolved_model: str = Field(min_length=1)
    usage: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def valid_probabilities(self) -> ModelDecision:
        values = self.probabilities
        if set(values) != {"buy", "sell", "hold"}:
            raise ValueError("all three action probabilities are required")
        # TypeSafe rounds displayed probabilities to 2 decimals. Three rounded
        # values can differ from 1 by at most 0.015; preserve, never normalize them.
        if any(not 0 <= p <= 1 for p in values.values()) or abs(sum(values.values()) - 1) > 0.015 + 1e-8:
            raise ValueError("invalid probability distribution")
        if values[self.action] + 1e-8 < max(values.values()):
            raise ValueError("choice does not match the most probable action")
        return self


class DecisionSignal(Contract):
    schema_version: Literal["1"] = "1"
    decision_id: str
    context_id: str
    symbol: str
    created_at: datetime
    valid_until: datetime
    config: DecisionConfig
    model_source: Literal["jev", "recorded"]
    requested_model: str
    resolved_model: str | None = None
    model_action: Action | None = None
    final_action: Action = "hold"
    status: Status
    action_probabilities: dict[Action, float] | None = None
    confidence: float | None = None
    reason_codes: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    policy_trace: list[dict[str, Any]] = Field(default_factory=list)
    latency_ms: int | None = None
    usage: dict[str, Any] = Field(default_factory=dict)
    execution_mode: Literal["signal_only"] = "signal_only"
    account_validation: Literal["caller_supplied_constraints_only"] = "caller_supplied_constraints_only"
