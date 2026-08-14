"""Failure-surface drill (pipeline section 8, build prompt 6.3): one test per
row of the failure table that has no coverage elsewhere.

Rows already covered by their own suites are NOT re-tested here — see
docs/reports/m6-failure-drill.md for the full row -> test mapping. This file
holds the rows that had nothing:

  row 1  thin brief          -> one clarifying round, then proceed
  row 3  gate failure        -> bounded retry with the report injected
  row 4  section fails twice -> placeholder + report; the site continues
  row 5  worker crash        -> the other routes survive
  row 6  manifest conflict   -> rejected, and treated as a gate failure

Everything here is offline: the model, the gates CLI, and the page-worker
subprocess are all faked, so the retry/exhaustion CONTROL FLOW is what gets
exercised rather than model behavior.
"""

import json
from pathlib import Path

from orchestrator.plan_pipeline import (
    INTAKE_TOOL_FIRST,
    INTAKE_TOOL_FOLLOWUP,
    validate_siteplan,
)
from orchestrator.section_pipeline import (
    MAX_ATTEMPTS,
    assemble_page_index_source,
    user_prompt_with_failures,
)

# ---------- row 1: thin brief -> ONE clarifying round, then proceed ----------


def test_first_intake_round_may_ask_clarifying_questions() -> None:
    assert "clarifyingQuestions" in INTAKE_TOOL_FIRST["properties"]


def test_the_second_intake_round_cannot_ask_again() -> None:
    """"One clarifying round" is enforced structurally, not by instruction:
    the follow-up call's tool schema has no clarifyingQuestions field at all
    and requires the brief, so an infinite question loop is unrepresentable
    rather than merely discouraged."""
    assert "clarifyingQuestions" not in INTAKE_TOOL_FOLLOWUP["properties"]
    assert INTAKE_TOOL_FOLLOWUP["required"] == ["brief"]


def test_the_brief_carries_recorded_assumptions_forward() -> None:
    """Row 1's "proceed with recorded assumptions": assumptions are part of
    the brief schema, so what the intake agent guessed travels with the brief
    to every downstream agent instead of being lost."""
    brief_properties = INTAKE_TOOL_FIRST["properties"]["brief"]["properties"]
    assert "assumptions" in brief_properties
    assert brief_properties["assumptions"]["type"] == "array"


# ---------- row 3: gate failure -> bounded retry with the report injected ----------


def test_the_failure_report_is_injected_into_the_retry_prompt() -> None:
    base = "Section brief: a hero"
    retried = user_prompt_with_failures(base, "- gate 3 (tokens-only): Raw hex color \"#fff\"")
    assert base in retried
    assert "#fff" in retried
    # and a clean first attempt is not polluted with an empty report block
    assert user_prompt_with_failures(base, "") == base


def test_the_retry_budget_is_bounded() -> None:
    """Pipeline 5.4: 1 generation + at most 2 retries. The bound is what makes
    a persistently-failing section terminate in a placeholder instead of
    looping on spend forever."""
    assert MAX_ATTEMPTS == 3


# ---------- row 4: section fails twice -> placeholder; the site continues ----------


def test_a_failed_section_becomes_a_placeholder_and_its_siblings_still_render() -> None:
    source = assemble_page_index_source(
        route_slug="home",
        sections=[
            {"slug": "hero", "component": "Hero"},
            {"slug": "broken", "failed": True},
            {"slug": "cta-band", "component": "CtaBand"},
        ],
    )
    # the failure is visible...
    assert "FailedSectionPlaceholder" in source
    # ...and the sections around it are untouched: the page still assembles
    assert '<Hero nodeId="home.hero"' in source
    assert '<CtaBand nodeId="home.cta-band"' in source
    # the failed section never claims a node id (no agent proposed one, so a
    # data-node-id here would fail gate 4's node-ids-registered check)
    assert "home.broken" not in source


def test_a_page_of_only_failures_still_produces_a_valid_module() -> None:
    """The degenerate case: every section on a route exhausted its retries.
    The page must still be a compilable module (the shell renders it, and the
    other routes are unaffected) rather than an empty or broken file."""
    source = assemble_page_index_source(
        route_slug="shop",
        sections=[{"slug": "a", "failed": True}, {"slug": "b", "failed": True}],
    )
    assert source.count("<FailedSectionPlaceholder />") == 2
    # imported exactly once no matter how many placeholders render
    assert source.count("import FailedSectionPlaceholder") == 1
    assert "export default function ShopPage()" in source


# ---------- row 6: manifest conflict -> rejected, and treated as a gate failure ----------


def test_a_rejected_plan_produces_a_report_shaped_for_prompt_injection() -> None:
    """Row 6's "treated as a gate failure" means the rejection has to come
    back as report LINES the retry prompt can carry, not as an exception —
    the same shape validate_siteplan and format_gate_failures produce."""
    plan = {
        "routes": [
            {
                "slug": "home",
                "path": "/",
                "pageArchetype": "landing",
                "title": "Home",
                "sections": [{"slug": "x", "archetype": "not-a-real-archetype", "brief": "b"}],
            }
        ]
    }
    issues = validate_siteplan(plan)
    assert issues, "an uncataloged archetype must be rejected"
    assert all(isinstance(issue, str) for issue in issues)
    # and the report survives injection into a retry prompt
    report = "\n".join(f"- {issue}" for issue in issues)
    assert "not-a-real-archetype" in user_prompt_with_failures("plan this", report)


# ---------- row 5: worker crash -> the other routes survive ----------


class _FakeProc:
    """Stands in for a page-worker subprocess. run_fanout only ever touches
    communicate() and returncode."""

    def __init__(self, returncode: int, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self._stdout = stdout
        self._stderr = stderr

    def communicate(self) -> tuple[str, str]:
        return self._stdout, self._stderr


class _FakeCompletedProcess:
    def __init__(self, stdout: str) -> None:
        self.stdout = stdout
        self.returncode = 0


def _fanout_project(tmp_path: Path, slugs: list[str]) -> Path:
    project = tmp_path / "run-crash"
    (project / "plan").mkdir(parents=True)
    (project / "plan" / "siteplan.json").write_text(
        json.dumps({"routes": [{"slug": slug, "path": f"/{slug}"} for slug in slugs]}),
        encoding="utf-8",
    )
    return project


def test_a_crashed_page_worker_is_recorded_and_its_siblings_still_finish(
    tmp_path: Path, monkeypatch
) -> None:
    """Pipeline 5.3/section 8 row 5: workers are real OS processes precisely so
    one dying cannot touch another. The crash must surface with its exit code
    and stderr (so it is diagnosable and the section checkpoint can be
    resumed), the surviving routes must still report success, and the run as a
    whole must NOT claim to have passed."""
    from orchestrator import fanout

    project = _fanout_project(tmp_path, ["home", "shop", "about"])
    monkeypatch.setattr(fanout, "GENERATED_DIR", tmp_path)
    monkeypatch.setattr(fanout, "ensure_route_page_dirs", lambda *a, **k: None)
    monkeypatch.setattr(
        fanout,
        "_run_compiler_cli",
        lambda *a, **k: _FakeCompletedProcess(json.dumps({"passed": True, "gates": []})),
    )

    outcomes = {
        "home": _FakeProc(0, stdout="home ok"),
        "shop": _FakeProc(1, stderr="Traceback: KeyError 'sectionMeta'"),
        "about": _FakeProc(0, stdout="about ok"),
    }
    monkeypatch.setattr(fanout, "spawn_worker", lambda run_id, slug: outcomes[slug])

    result = fanout.run_fanout(project.name)

    # the crash is visible, with the diagnostic detail needed to resume it
    assert result["workers"]["shop"]["returncode"] == 1
    assert "sectionMeta" in result["workers"]["shop"]["stderr_tail"]
    # ...its siblings completed independently
    assert result["workers"]["home"]["returncode"] == 0
    assert result["workers"]["about"]["returncode"] == 0
    # ...and the run does not pass just because the gates did
    assert result["gate_report"]["passed"] is True
    assert result["passed"] is False


def test_fanout_fails_when_gates_fail_even_though_every_worker_exited_clean(
    tmp_path: Path, monkeypatch
) -> None:
    """The converse guard: a clean exit code from every worker is not evidence
    the project is sound — the project-level gate 6 check (real write log vs.
    ownership map, contract 8.6) runs after fan-out and can still reject."""
    from orchestrator import fanout

    project = _fanout_project(tmp_path, ["home"])
    monkeypatch.setattr(fanout, "GENERATED_DIR", tmp_path)
    monkeypatch.setattr(fanout, "ensure_route_page_dirs", lambda *a, **k: None)
    monkeypatch.setattr(fanout, "spawn_worker", lambda run_id, slug: _FakeProc(0))
    monkeypatch.setattr(
        fanout,
        "_run_compiler_cli",
        lambda *a, **k: _FakeCompletedProcess(
            json.dumps(
                {
                    "passed": False,
                    "gates": [
                        {
                            "gate": 6,
                            "name": "ownership-boundaries",
                            "passed": False,
                            "failures": [{"message": "page:home wrote src/shell/Nav.tsx"}],
                        }
                    ],
                }
            )
        ),
    )

    result = fanout.run_fanout(project.name)
    assert result["workers"]["home"]["returncode"] == 0
    assert result["passed"] is False


def test_a_successful_workers_repair_warning_escapes_its_subprocess(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    """I1: the deterministic-repair warning was written to a stream nothing read.

    A page worker is a subprocess. Its stdout was tailed into
    `workers[slug]["stdout_tail"]` — one occurrence in the whole repo, its own
    assignment — while `main()` strips `workers` before printing and
    `acceptance.py` keeps only FAILED workers' `stderr_tail`. So the author's
    declared "only signal that the prompt has stopped working" reached no log, no
    run report, no `job.error` and no UI on exactly the run where it matters: a
    SUCCESSFUL one, which is why this worker exits 0.

    Two things must hold: the warning is re-emitted by the PARENT (whose stdout
    the job result carries), and it appears OUTSIDE `workers` in the result, since
    anything nested there is stripped before printing.
    """
    from orchestrator import fanout
    from orchestrator.section_pipeline import REPAIR_WARNING_PREFIX

    warning = f"{REPAIR_WARNING_PREFIX} 1 unloadable image URL(s) in src/pages/home/mock/Hero.data.ts"
    project = _fanout_project(tmp_path, ["home"])
    monkeypatch.setattr(fanout, "GENERATED_DIR", tmp_path)
    monkeypatch.setattr(fanout, "ensure_route_page_dirs", lambda *a, **k: None)
    monkeypatch.setattr(
        fanout,
        "_run_compiler_cli",
        lambda *a, **k: _FakeCompletedProcess(json.dumps({"passed": True, "gates": []})),
    )
    # the warning sits at the START of a stream long enough that the 1500-char
    # tail cannot contain it — the truncation is half the finding
    noise = "kitaru: checkpoint cached\n" * 200
    monkeypatch.setattr(
        fanout,
        "spawn_worker",
        lambda run_id, slug: _FakeProc(0, stdout=f"{warning}\n{noise}"),
    )

    result = fanout.run_fanout(project.name)

    assert warning not in result["workers"]["home"]["stdout_tail"], "premise: the tail loses it"
    assert result["repair_warnings"] == [f"home: {warning}"]
    assert "repair_warnings" in {k: v for k, v in result.items() if k != "workers"}
    assert warning in capsys.readouterr().out


def test_the_fanout_write_log_and_ownership_files_are_cleaned_up(tmp_path: Path, monkeypatch) -> None:
    """These two files exist only to hand the gates CLI the real write log;
    leaving them behind would put generator scratch files into the export."""
    from orchestrator import fanout

    project = _fanout_project(tmp_path, ["home"])
    monkeypatch.setattr(fanout, "GENERATED_DIR", tmp_path)
    monkeypatch.setattr(fanout, "ensure_route_page_dirs", lambda *a, **k: None)
    monkeypatch.setattr(fanout, "spawn_worker", lambda run_id, slug: _FakeProc(0))
    monkeypatch.setattr(
        fanout,
        "_run_compiler_cli",
        lambda *a, **k: _FakeCompletedProcess(json.dumps({"passed": True, "gates": []})),
    )

    fanout.run_fanout(project.name)
    assert not (project / ".fanout-write-log.json").exists()
    assert not (project / ".fanout-ownership.json").exists()
