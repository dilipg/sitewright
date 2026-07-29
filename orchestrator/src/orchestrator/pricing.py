"""Dollar-cost estimation for pipeline runs (build-plan "Definition of v1
done": model cost per 6-page site, target <$10, ceiling <$15). No pricing
calculator existed anywhere in the codebase before milestone 5.5 — every
prior measurement (soak.py, archetype_soak.py) compared raw tokens to a
token budget, never converted to dollars. Rates are Anthropic's published
first-party per-token prices (standard, non-promotional) as of 2026-07-29;
keep in sync with config.py's TIER_MODELS if the tiering ever changes model
IDs. Cache-write is priced at the 5-minute ephemeral TTL rate — no call site
in this codebase ever sets ttl="1h"."""

from orchestrator.runlog import default_run_log_path, read_run_events

PRICING_PER_TOKEN: dict[str, dict[str, float]] = {
    "claude-sonnet-5": {
        "input": 3.00 / 1_000_000,
        "output": 15.00 / 1_000_000,
        "cache_write": 3.75 / 1_000_000,  # 1.25x input, 5m TTL
        "cache_read": 0.30 / 1_000_000,  # 0.1x input
    },
    "claude-haiku-4-5-20251001": {
        "input": 1.00 / 1_000_000,
        "output": 5.00 / 1_000_000,
        "cache_write": 1.25 / 1_000_000,
        "cache_read": 0.10 / 1_000_000,
    },
    "claude-haiku-4-5": {
        "input": 1.00 / 1_000_000,
        "output": 5.00 / 1_000_000,
        "cache_write": 1.25 / 1_000_000,
        "cache_read": 0.10 / 1_000_000,
    },
}


def usage_cost(model: str, usage: dict) -> float:
    """Dollar cost of one usage dict — the shape logged by every
    `*.complete`/`section.generated` run-log event: input_tokens,
    output_tokens, cache_creation_input_tokens, cache_read_input_tokens."""
    rates = PRICING_PER_TOKEN.get(model)
    if rates is None:
        raise KeyError(f"no pricing configured for model {model!r}")
    return (
        usage.get("input_tokens", 0) * rates["input"]
        + usage.get("output_tokens", 0) * rates["output"]
        + usage.get("cache_creation_input_tokens", 0) * rates["cache_write"]
        + usage.get("cache_read_input_tokens", 0) * rates["cache_read"]
    )


def run_cost(events: list[dict]) -> dict:
    """Aggregate cost + tokens across every usage-bearing event (any event
    carrying both "model" and "usage" — intake.complete, plan.complete,
    tokens.complete, primitives.complete, shell.complete, section.generated).
    Events without both fields (e.g. section.validated) are skipped.

    A model absent from PRICING_PER_TOKEN (e.g. "gemini-flash-latest" under
    the ORCH_MODEL_PROVIDER=gemini escape hatch) never raises: its tokens
    still count toward total_tokens, but its cost_usd is None rather than a
    misleading 0.0, and its name is listed in unpriced_models so callers can
    tell total_cost_usd is a partial figure, not a true zero."""
    by_model: dict[str, dict] = {}
    unpriced_models: list[str] = []
    for event in events:
        model = event.get("model")
        usage = event.get("usage")
        if model is None or usage is None:
            continue
        bucket = by_model.setdefault(
            model,
            {
                "input_tokens": 0,
                "output_tokens": 0,
                "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0,
                "calls": 0,
                "cost_usd": 0.0 if model in PRICING_PER_TOKEN else None,
            },
        )
        bucket["input_tokens"] += usage.get("input_tokens", 0)
        bucket["output_tokens"] += usage.get("output_tokens", 0)
        bucket["cache_read_input_tokens"] += usage.get("cache_read_input_tokens", 0)
        bucket["cache_creation_input_tokens"] += usage.get("cache_creation_input_tokens", 0)
        bucket["calls"] += 1
        if model in PRICING_PER_TOKEN:
            bucket["cost_usd"] += usage_cost(model, usage)
        elif model not in unpriced_models:
            unpriced_models.append(model)

    total_tokens = sum(
        v["input_tokens"]
        + v["output_tokens"]
        + v["cache_read_input_tokens"]
        + v["cache_creation_input_tokens"]
        for v in by_model.values()
    )
    total_cost = sum(v["cost_usd"] for v in by_model.values() if v["cost_usd"] is not None)
    return {
        "by_model": by_model,
        "total_tokens": total_tokens,
        "total_cost_usd": total_cost,
        "unpriced_models": unpriced_models,
    }


def cost_for_run(run_id: str) -> dict:
    """Convenience wrapper: read a run's own JSONL log and aggregate cost.
    Safe to call for a freshly-generated run_id (fresh log = this run's
    events only, no cross-run contamination to filter out)."""
    return run_cost(read_run_events(default_run_log_path(run_id)))
