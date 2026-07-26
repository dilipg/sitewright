"""Run log v1 (pipeline section 7): JSONL events with the fields that make
dynamic-context prompts debuggable."""

from pathlib import Path

from orchestrator.runlog import append_run_event, read_run_events


def test_append_and_read_round_trip(tmp_path: Path) -> None:
    log = tmp_path / "run.jsonl"
    append_run_event(
        log,
        run_id="run-001",
        event_type="section.generated",
        section="home.hero",
        template_name="hero",
        template_version="1.0.0",
        template_hash="abc123def456",
        prompt_hash="fedcba654321",
        system_prompt="SYSTEM...",
        user_prompt="USER...",
        model="claude-sonnet-5",
        params={"max_tokens": 4096},
        usage={"input_tokens": 1200, "output_tokens": 900},
        gate_results=None,
        checkpoint_ref="exec-1/call_model",
    )
    append_run_event(
        log,
        run_id="run-001",
        event_type="section.validated",
        section="home.hero",
        gate_results={"passed": True, "failures": []},
    )

    events = read_run_events(log)
    assert len(events) == 2
    assert events[0]["event_type"] == "section.generated"
    assert events[0]["prompt_hash"] == "fedcba654321"
    assert events[0]["usage"]["output_tokens"] == 900
    assert events[1]["gate_results"]["passed"] is True
    assert all("timestamp" in event for event in events)


def test_read_missing_log_is_empty(tmp_path: Path) -> None:
    assert read_run_events(tmp_path / "absent.jsonl") == []
