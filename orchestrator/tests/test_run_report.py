"""DAG run report (pipeline section 7, build prompt 6.3): the DAG is
reconstructed from the flat event stream, so these tests feed synthetic
events and assert the resulting structure, rollups, costs and drill-down
payloads. Rendering is checked only for the properties that matter
(self-contained, escaped, everything present)."""

import json

from orchestrator.run_report import build_dag, render_html

SONNET = "claude-sonnet-5"


def usage(inp: int = 1000, out: int = 500, cache_read: int = 0, cache_write: int = 0) -> dict:
    return {
        "input_tokens": inp,
        "output_tokens": out,
        "cache_read_input_tokens": cache_read,
        "cache_creation_input_tokens": cache_write,
    }


def generated(section: str, attempt: int, *, at: str, exec_id: str = "e1", **extra) -> dict:
    return {
        "timestamp": at,
        "event_type": "section.generated",
        "section": section,
        "attempt": attempt,
        "model": SONNET,
        "usage": usage(),
        "template_name": "hero",
        "template_version": "1.0.1",
        "prompt_hash": "abc123",
        "system_prompt": "SYSTEM TEXT",
        "user_prompt": "USER TEXT",
        "raw_output": '{"files": {}}',
        "checkpoint_ref": f"{exec_id}/generate_section#a{attempt}",
        **extra,
    }


def validated(section: str, attempt: int, *, at: str, passed: bool, failures=()) -> dict:
    return {
        "timestamp": at,
        "event_type": "section.validated",
        "section": section,
        "attempt": attempt,
        "gate_results": {
            "passed": passed,
            "failures": [
                {"gate": 4, "reason": "unregistered-node-id", "message": message}
                for message in failures
            ],
        },
        "checkpoint_ref": "e1/run_gates_step#a1",
    }


def stage_event(event_type: str, *, at: str) -> dict:
    return {
        "timestamp": at,
        "event_type": event_type,
        "model": SONNET,
        "usage": usage(),
        "raw_output": "{}",
        "checkpoint_ref": "e0/step",
    }


def test_an_empty_log_yields_an_empty_dag() -> None:
    dag = build_dag([])
    assert dag["stages"] == []
    assert dag["node_count"] == 0
    assert dag["status"] == "unknown"


def test_stages_appear_in_pipeline_order_not_log_order() -> None:
    """The report has to read the way the run executed; the log is appended in
    whatever order concurrent workers happen to finish."""
    events = [
        stage_event("shell.complete", at="2026-07-30T00:00:30+00:00"),
        stage_event("intake.complete", at="2026-07-30T00:00:00+00:00"),
        stage_event("primitives.complete", at="2026-07-30T00:00:20+00:00"),
        stage_event("plan.complete", at="2026-07-30T00:00:10+00:00"),
        generated("home.hero", 1, at="2026-07-30T00:00:40+00:00"),
        validated("home.hero", 1, at="2026-07-30T00:00:45+00:00", passed=True),
    ]
    dag = build_dag(events)
    assert [stage["name"] for stage in dag["stages"]] == [
        "intake",
        "plan",
        "design",
        "shell",
        "fan-out",
    ]


def test_sections_are_grouped_under_their_route() -> None:
    events = [
        generated("shop.product-grid", 1, at="2026-07-30T00:01:00+00:00"),
        validated("shop.product-grid", 1, at="2026-07-30T00:01:05+00:00", passed=True),
        generated("home.hero", 1, at="2026-07-30T00:00:40+00:00"),
        validated("home.hero", 1, at="2026-07-30T00:00:45+00:00", passed=True),
    ]
    fanout = build_dag(events)["stages"][0]
    assert fanout["name"] == "fan-out"
    assert [group["name"] for group in fanout["groups"]] == ["home", "shop"]
    assert [node["id"] for node in fanout["groups"][0]["nodes"]] == ["home.hero"]


def test_a_failed_section_makes_its_route_and_the_run_failed() -> None:
    """Section 8's whole point: a failure must be visible at every level, not
    averaged away by its passing siblings."""
    events = [
        generated("home.hero", 1, at="2026-07-30T00:00:40+00:00"),
        validated("home.hero", 1, at="2026-07-30T00:00:45+00:00", passed=True),
        generated("home.broken", 1, at="2026-07-30T00:00:50+00:00"),
        validated(
            "home.broken", 1, at="2026-07-30T00:00:55+00:00", passed=False, failures=["never attached"]
        ),
    ]
    dag = build_dag(events)
    nodes = {node["id"]: node for node in dag["stages"][0]["groups"][0]["nodes"]}
    assert nodes["home.hero"]["status"] == "passed"
    assert nodes["home.broken"]["status"] == "failed"
    assert dag["stages"][0]["groups"][0]["status"] == "failed"
    assert dag["stages"][0]["status"] == "failed"
    assert dag["status"] == "failed"


def test_a_section_with_no_gate_verdict_is_unknown_not_passed() -> None:
    """A crashed worker (failure table row 5) leaves a generation event with no
    matching validation. Reporting that as success would hide the crash."""
    dag = build_dag([generated("home.hero", 1, at="2026-07-30T00:00:40+00:00")])
    node = dag["stages"][0]["groups"][0]["nodes"][0]
    assert node["status"] == "unknown"
    assert dag["status"] == "unknown"


def test_every_retry_is_kept_as_its_own_attempt_with_its_gate_failures() -> None:
    """Drill-down has to show the retry history: which attempt failed which
    gate is exactly what makes a bad prompt diagnosable (section 7)."""
    events = [
        generated("home.hero", 1, at="2026-07-30T00:00:40+00:00"),
        validated("home.hero", 1, at="2026-07-30T00:00:45+00:00", passed=False, failures=["raw hex"]),
        generated("home.hero", 2, at="2026-07-30T00:00:50+00:00"),
        validated("home.hero", 2, at="2026-07-30T00:00:55+00:00", passed=True),
    ]
    node = build_dag(events)["stages"][0]["groups"][0]["nodes"][0]
    assert [attempt["attempt"] for attempt in node["attempts"]] == [1, 2]
    assert node["attempts"][0]["gates_passed"] is False
    assert "raw hex" in node["attempts"][0]["gate_failures"][0]
    assert node["attempts"][1]["gates_passed"] is True
    # the node's own status follows the LAST verdict, not the first
    assert node["status"] == "passed"


def test_each_attempt_carries_the_rendered_prompts_and_raw_output() -> None:
    node = build_dag([generated("home.hero", 1, at="2026-07-30T00:00:40+00:00")])["stages"][0][
        "groups"
    ][0]["nodes"][0]
    attempt = node["attempts"][0]
    assert attempt["system_prompt"] == "SYSTEM TEXT"
    assert attempt["user_prompt"] == "USER TEXT"
    assert attempt["raw_output"] == '{"files": {}}'
    assert attempt["template_version"] == "1.0.1"
    assert attempt["prompt_hash"] == "abc123"


def test_cost_and_tokens_roll_up_from_attempts_to_the_run() -> None:
    events = [
        generated("home.hero", 1, at="2026-07-30T00:00:40+00:00"),
        validated("home.hero", 1, at="2026-07-30T00:00:45+00:00", passed=True),
        generated("shop.grid", 1, at="2026-07-30T00:01:00+00:00"),
        validated("shop.grid", 1, at="2026-07-30T00:01:05+00:00", passed=True),
    ]
    dag = build_dag(events)
    # 1000 in + 500 out per call, sonnet-5: 1000*3/1e6 + 500*15/1e6 = 0.0105
    assert dag["stages"][0]["groups"][0]["nodes"][0]["cost_usd"] == 0.0105
    assert dag["total_cost_usd"] == 0.021
    assert dag["total_tokens"] == 3000
    assert dag["unpriced"] is False


def test_an_unpriced_model_is_flagged_rather_than_counted_as_free() -> None:
    """Same contract as run_cost: a gemini-escape-hatch call must not make the
    total look cheaper than it was."""
    event = generated("home.hero", 1, at="2026-07-30T00:00:40+00:00")
    event["model"] = "gemini-flash-latest"
    dag = build_dag([event])
    node = dag["stages"][0]["groups"][0]["nodes"][0]
    assert node["unpriced"] is True
    assert node["cost_usd"] == 0.0
    assert dag["unpriced"] is True
    # tokens still count — only the dollar figure is unknown
    assert dag["total_tokens"] == 1500


def test_the_run_span_is_measured_across_every_node() -> None:
    events = [
        stage_event("intake.complete", at="2026-07-30T00:00:00+00:00"),
        generated("home.hero", 1, at="2026-07-30T00:01:00+00:00"),
        validated("home.hero", 1, at="2026-07-30T00:01:30+00:00", passed=True),
    ]
    dag = build_dag(events)
    assert dag["started_at"] == "2026-07-30T00:00:00+00:00"
    assert dag["ended_at"] == "2026-07-30T00:01:30+00:00"
    assert dag["duration_s"] == 90.0


def test_a_validation_with_no_matching_generation_is_still_shown() -> None:
    """A log truncated mid-run (killed process) must not silently drop its
    last verdict."""
    dag = build_dag([validated("home.hero", 1, at="2026-07-30T00:00:45+00:00", passed=False)])
    node = dag["stages"][0]["groups"][0]["nodes"][0]
    assert len(node["attempts"]) == 1
    assert node["attempts"][0]["gates_passed"] is False
    assert node["status"] == "failed"


def test_build_dag_is_deterministic() -> None:
    events = [
        generated("shop.grid", 1, at="2026-07-30T00:01:00+00:00"),
        generated("home.hero", 1, at="2026-07-30T00:00:40+00:00"),
        validated("home.hero", 1, at="2026-07-30T00:00:45+00:00", passed=True),
        validated("shop.grid", 1, at="2026-07-30T00:01:05+00:00", passed=True),
    ]
    assert json.dumps(build_dag(events)) == json.dumps(build_dag(events))


# ---------- rendering ----------


def test_the_report_is_a_single_self_contained_file() -> None:
    dag = build_dag([generated("home.hero", 1, at="2026-07-30T00:00:40+00:00")])
    html_text = render_html("run-x", dag)
    assert html_text.startswith("<!doctype html>")
    # no external fetches: a report has to open from disk, offline
    assert "http://" not in html_text
    assert "https://" not in html_text
    assert "<script src" not in html_text
    assert "<link" not in html_text


def test_the_report_carries_the_dag_and_the_run_summary() -> None:
    events = [
        generated("home.hero", 1, at="2026-07-30T00:00:40+00:00"),
        validated("home.hero", 1, at="2026-07-30T00:00:45+00:00", passed=True),
    ]
    html_text = render_html("run-x", build_dag(events))
    assert "run-x" in html_text
    assert "window.__DAG__" in html_text
    assert "SYSTEM TEXT" in html_text  # drill-down payload is inlined
    assert "0.0105" in html_text  # per-node cost


def test_a_prompt_containing_a_script_tag_cannot_break_out_of_the_page() -> None:
    """Prompts are full of JSX and the raw output is model text — inlining
    either unescaped would let a "</script>" end the data block early and
    corrupt (or inject into) the report."""
    event = generated("home.hero", 1, at="2026-07-30T00:00:40+00:00")
    event["raw_output"] = "</script><script>window.__pwned = 1;</script>"
    html_text = render_html("run-x", build_dag([event]))
    assert "</script><script>window.__pwned" not in html_text
    assert "\\u003c/script\\u003e" in html_text


def test_the_dag_total_agrees_with_run_cost_on_the_same_events() -> None:
    """The report and the cost summary must never disagree about what a run
    cost. Both read pricing.py, but they aggregate independently (per-node
    vs per-model), so this pins them together. Verified live too: both agree
    to 6 decimals on two real full runs (docs/reports/m6-failure-drill.md)."""
    from orchestrator.pricing import run_cost

    events = [
        stage_event("intake.complete", at="2026-07-30T00:00:00+00:00"),
        stage_event("tokens.complete", at="2026-07-30T00:00:10+00:00"),
        generated("home.hero", 1, at="2026-07-30T00:00:40+00:00"),
        validated("home.hero", 1, at="2026-07-30T00:00:45+00:00", passed=False, failures=["x"]),
        generated("home.hero", 2, at="2026-07-30T00:00:50+00:00"),
        validated("home.hero", 2, at="2026-07-30T00:00:55+00:00", passed=True),
        generated("shop.grid", 1, at="2026-07-30T00:01:00+00:00"),
        validated("shop.grid", 1, at="2026-07-30T00:01:05+00:00", passed=True),
    ]
    dag = build_dag(events)
    summary = run_cost(events)
    assert abs(dag["total_cost_usd"] - summary["total_cost_usd"]) < 1e-12
    assert dag["total_tokens"] == summary["total_tokens"]


# ---------- measured call latency (added 6.3) ----------


def test_a_logged_call_duration_gives_the_node_a_real_span() -> None:
    """duration_s lets the report derive when a call STARTED: run-log
    timestamps are written at completion, so without it a node's bar can only
    mark where it finished."""
    event = generated("home.hero", 1, at="2026-07-30T00:01:00+00:00")
    event["duration_s"] = 42.5
    node = build_dag([event])["stages"][0]["groups"][0]["nodes"][0]
    assert node["measured_s"] == 42.5
    assert node["ended_at"] == "2026-07-30T00:01:00+00:00"
    assert node["started_at"] == "2026-07-30T00:00:17.500000+00:00"


def test_measured_latency_sums_across_retries_and_rolls_up() -> None:
    events = [
        generated("home.hero", 1, at="2026-07-30T00:01:00+00:00", duration_s=30.0),
        validated("home.hero", 1, at="2026-07-30T00:01:02+00:00", passed=False, failures=["x"]),
        generated("home.hero", 2, at="2026-07-30T00:02:00+00:00", duration_s=20.0),
        validated("home.hero", 2, at="2026-07-30T00:02:02+00:00", passed=True),
    ]
    dag = build_dag(events)
    node = dag["stages"][0]["groups"][0]["nodes"][0]
    assert node["measured_s"] == 50.0
    assert dag["stages"][0]["groups"][0]["measured_s"] == 50.0
    assert dag["measured_s"] == 50.0
    # each attempt keeps its own latency for the drill-down
    assert [attempt["duration_s"] for attempt in node["attempts"]] == [30.0, 20.0]


def test_a_run_logged_before_durations_existed_still_renders() -> None:
    """Backward compatibility: the log is append-only and older runs carry no
    duration_s. They must still produce a report — with measured latency
    absent rather than reported as zero."""
    events = [
        generated("home.hero", 1, at="2026-07-30T00:01:00+00:00"),
        validated("home.hero", 1, at="2026-07-30T00:01:05+00:00", passed=True),
    ]
    dag = build_dag(events)
    assert dag["measured_s"] == 0.0
    assert dag["duration_s"] == 5.0  # falls back to the event span
    html_text = render_html("old-run", dag)
    assert "in model calls" not in html_text
    assert "5.0s wall" in html_text


def test_the_header_reports_measured_model_time_when_available() -> None:
    events = [generated("home.hero", 1, at="2026-07-30T00:01:00+00:00", duration_s=42.0)]
    html_text = render_html("new-run", build_dag(events))
    assert "42s in model calls" in html_text
