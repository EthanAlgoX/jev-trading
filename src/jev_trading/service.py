import time
from datetime import timedelta

from .contracts import ContextSnapshot, DecisionConfig, DecisionSignal, digest, utcnow
from .model import ModelFailure, build_request, parse_response
from .policy import apply_policy, precheck, quality_warnings
from .storage import DecisionStore


async def decide(context: ContextSnapshot, config: DecisionConfig, classifier, store: DecisionStore,
                 retry_token: str = "", clock=utcnow) -> DecisionSignal:
    request = build_request(context, config, classifier.model)
    run_id = digest({"request": request, "source": classifier.source,
                     "model_identity": classifier.cache_identity, "retry_token": retry_token})
    previous = store.claim(run_id, context, request)
    if previous is not None:
        if clock() >= previous.valid_until:
            return previous.model_copy(update={
                "status": "expired", "final_action": "hold",
                "reason_codes": [*previous.reason_codes, "SIGNAL_EXPIRED"],
                "policy_trace": [*previous.policy_trace, {"rule": "SIGNAL_EXPIRED",
                                  "before": previous.final_action, "after": "hold"}],
            })
        return previous
    started = clock()
    expires = context.captured_at + timedelta(seconds=config.validity_seconds)
    signal = DecisionSignal(
        decision_id=run_id, context_id=context.context_id, symbol=context.symbol,
        created_at=started, valid_until=expires, config=config, status="skipped",
        model_source=classifier.source, requested_model=classifier.model,
        inference=getattr(classifier, "inference", None),
        warnings=quality_warnings(context),
    )
    raw = None
    reasons = precheck(context, config, started, expires)
    if reasons:
        signal.reason_codes = reasons
        signal.status = "expired" if "CONTEXT_EXPIRED" in reasons else "skipped"
    else:
        t0 = time.monotonic()
        try:
            raw = await classifier.classify(request, config.request_timeout_seconds)
            model = parse_response(raw)
            signal.model_action = model.action
            signal.resolved_model = model.resolved_model
            signal.action_probabilities = model.probabilities
            if abs(sum(model.probabilities.values()) - 1) > 1e-5:
                signal.warnings.append("PROBABILITIES_ROUNDED")
            signal.confidence = model.confidence
            signal.usage = model.usage
            reasons = apply_policy(context, config, model)
            if clock() >= expires:
                reasons.append("LATE_MODEL_RESPONSE")
                signal.status = "expired"
            else:
                signal.status = "blocked" if reasons else "accepted"
            signal.reason_codes = reasons
            signal.final_action = "hold" if reasons else model.action
        except ModelFailure as exc:
            raw = exc.raw if exc.raw is not None else raw
            signal.status = "error"
            signal.reason_codes = [exc.code]
        finally:
            external_latency = getattr(classifier, "external_latency_ms", None)
            signal.latency_ms = (
                external_latency if isinstance(external_latency, int) and external_latency >= 0
                else round((time.monotonic() - t0) * 1000)
            )
    signal.policy_trace = [{"rule": code, "before": signal.model_action, "after": signal.final_action}
                           for code in signal.reason_codes]
    store.finish(signal, raw)
    return signal
