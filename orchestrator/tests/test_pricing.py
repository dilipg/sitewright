"""Dollar-cost estimation (build-plan "Definition of v1 done": model cost per
6-page site, target <$10, ceiling <$15). No pricing calculator existed
anywhere in the codebase before 5.5 — every prior measurement (soak.py,
archetype_soak.py) compared raw tokens to a token budget, never converted to
dollars."""

from pathlib import Path

from orchestrator.pricing import cost_for_run, run_cost, usage_cost
from orchestrator.runlog import append_run_event


def test_usage_cost_known_model_sonnet() -> None:
    usage = {
        "input_tokens": 1_000_000,
        "output_tokens": 1_000_000,
        "cache_creation_input_tokens": 1_000_000,
        "cache_read_input_tokens": 1_000_000,
    }
    # 3.00 (input) + 15.00 (output) + 3.75 (cache write, 1.25x) + 0.30 (cache read, 0.1x)
    assert usage_cost("claude-sonnet-5", usage) == 22.05


def test_usage_cost_known_model_haiku() -> None:
    usage = {
        "input_tokens": 1_000_000,
        "output_tokens": 1_000_000,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    }
    # 1.00 (input) + 5.00 (output)
    assert usage_cost("claude-haiku-4-5-20251001", usage) == 6.00


def test_usage_cost_missing_fields_defaults_to_zero() -> None:
    assert usage_cost("claude-sonnet-5", {}) == 0.0


def test_usage_cost_unknown_model_raises() -> None:
    try:
        usage_cost("claude-opus-9000", {"input_tokens": 1})
    except KeyError:
        pass
    else:
        raise AssertionError("expected KeyError for an unpriced model")


def test_run_cost_aggregates_across_models_and_ignores_usageless_events() -> None:
    events = [
        {
            "event_type": "intake.complete",
            "model": "claude-haiku-4-5-20251001",
            "usage": {"input_tokens": 1000, "output_tokens": 200},
        },
        {
            "event_type": "tokens.complete",
            "model": "claude-sonnet-5",
            "usage": {"input_tokens": 5000, "output_tokens": 3000, "cache_read_input_tokens": 100},
        },
        {
            "event_type": "section.validated",
            "gate_results": {"passed": True, "failures": []},
        },
    ]
    result = run_cost(events)
    assert result["by_model"]["claude-haiku-4-5-20251001"]["calls"] == 1
    assert result["by_model"]["claude-sonnet-5"]["input_tokens"] == 5000
    assert result["total_tokens"] == 1000 + 200 + 5000 + 3000 + 100
    expected_total = usage_cost(
        "claude-haiku-4-5-20251001", {"input_tokens": 1000, "output_tokens": 200}
    ) + usage_cost(
        "claude-sonnet-5",
        {"input_tokens": 5000, "output_tokens": 3000, "cache_read_input_tokens": 100},
    )
    assert result["total_cost_usd"] == expected_total


def test_run_cost_empty_events() -> None:
    result = run_cost([])
    assert result == {"by_model": {}, "total_tokens": 0, "total_cost_usd": 0.0, "unpriced_models": []}


def test_run_cost_handles_an_unpriced_model_without_crashing() -> None:
    # Live-relevant: ORCH_MODEL_PROVIDER=gemini routes every role through
    # "gemini-flash-latest", a model with no entry in PRICING_PER_TOKEN.
    # Tokens must still be counted; cost must be reported as unknown (never
    # silently $0, which would misrepresent an unpriced model as free), and
    # the caller must be able to tell cost is incomplete for this run.
    events = [
        {
            "event_type": "intake.complete",
            "model": "gemini-flash-latest",
            "usage": {"input_tokens": 1000, "output_tokens": 200},
        },
        {
            "event_type": "plan.complete",
            "model": "claude-haiku-4-5-20251001",
            "usage": {"input_tokens": 500, "output_tokens": 100},
        },
    ]
    result = run_cost(events)
    assert result["by_model"]["gemini-flash-latest"]["input_tokens"] == 1000
    assert result["by_model"]["gemini-flash-latest"]["cost_usd"] is None
    assert result["by_model"]["claude-haiku-4-5-20251001"]["cost_usd"] is not None
    assert result["unpriced_models"] == ["gemini-flash-latest"]
    # total_cost_usd covers only priced models; total_tokens covers all of them
    assert result["total_tokens"] == 1000 + 200 + 500 + 100
    assert result["total_cost_usd"] == usage_cost(
        "claude-haiku-4-5-20251001", {"input_tokens": 500, "output_tokens": 100}
    )


def test_cost_for_run_reads_from_run_log(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("ORCHESTRATOR_RUNLOG_DIR", str(tmp_path))
    append_run_event(
        tmp_path / "run-x.jsonl",
        run_id="run-x",
        event_type="plan.complete",
        model="claude-haiku-4-5-20251001",
        usage={"input_tokens": 2000, "output_tokens": 500},
    )
    result = cost_for_run("run-x")
    assert result["by_model"]["claude-haiku-4-5-20251001"]["output_tokens"] == 500
    assert result["total_cost_usd"] > 0
