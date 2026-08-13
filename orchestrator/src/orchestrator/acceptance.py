"""End-to-end pipeline orchestration glue (build prompt 5.5): chains
plan -> approve -> design -> shell -> fan-out -> export in a single Python
process, measuring wall-clock per stage and aggregating token/dollar cost
from the run log. No such chain existed anywhere in the codebase before
5.5 -- every stage was a separate, independently human-invoked CLI, with
plan approval done by hand (editing plan-status.json) between plan and
design. See docs/decisions.md for the 2026-07-29 row recording this gap
and the decision to build this module rather than keep chaining CLIs by
hand.

Deliberately NOT pytest-covered: every stage below makes real, billed
Anthropic API calls. pytest stays offline (CLAUDE.md / docs/decisions.md
convention -- CI has no API key). Verify by hand-running:

    uv run python -m orchestrator.acceptance --brief "..."

and inspecting the printed report, per docs/build-prompts-v1.md 5.5's
VERIFY line (3 consecutive full runs inside the performance-table
ceilings; see docs/reports/m5-acceptance.md for the recorded results).
"""

import argparse
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import kitaru

from orchestrator.design_pipeline import design_system_flow
from orchestrator.fanout import max_parallel_workers, run_fanout
from orchestrator.plan_pipeline import plan_flow, require_plan_approval
from orchestrator.pricing import cost_for_run
from orchestrator.section_pipeline import GENERATED_DIR, _run_compiler_cli
from orchestrator.shell_pipeline import generate_shell_flow


class StageError(RuntimeError):
    """Raised for any pipeline-stage failure (a flow returning passed=False,
    a flow body raising, or a non-zero exporter exit) so the caller can
    report which stage failed without inspecting exception subclasses."""

    def __init__(self, stage: str, detail: str):
        super().__init__(f"{stage}: {detail}")
        self.stage = stage
        self.detail = detail


def fresh_run_id(prefix: str = "acceptance") -> str:
    """A fresh run_id per invocation, never reused across a code edit
    (docs/decisions.md 2026-07-28: Kitaru's checkpoint cache keys by
    function code + args, so a stale run_id can silently skip re-running a
    paired checkpoint after a pipeline-code change)."""
    return f"{prefix}-{int(time.time())}-{uuid.uuid4().hex[:8]}"


def approve_plan(run_id: str) -> None:
    """Mirrors the editor's approve endpoint (compiler/src/plan-api.ts):
    writes {"approved": true, "approvedAt": ISO} to plan-status.json. There
    is no dedicated Python writer in plan_pipeline.py -- its own docstring
    says the convention is "set plan-status.json approved=true" directly;
    this function IS that write, standing in for the human approval click
    an end-to-end run has no human present to perform."""
    status_path = GENERATED_DIR / run_id / "plan" / "plan-status.json"
    status_path.write_text(
        json.dumps(
            {"approved": True, "approvedAt": datetime.now(timezone.utc).isoformat()},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def degraded_sections(project_dir: Path) -> list[str]:
    """Sections the plan asked for that no manifest node was ever registered
    for — i.e. the ones that exhausted their retries and became placeholders."""
    plan_path = project_dir / "plan" / "siteplan.json"
    manifest_path = project_dir / "manifest.json"
    if not plan_path.exists() or not manifest_path.exists():
        return []
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    built = {
        node_id
        for node_id, node in manifest["nodes"].items()
        if node["status"] == "active" and node_id.count(".") == 1
    }
    return [
        f"{route['slug']}.{section['slug']}"
        for route in plan.get("routes", [])
        for section in route.get("sections", [])
        if f"{route['slug']}.{section['slug']}" not in built
    ]


def generate_site(brief: str, run_id: str | None = None) -> dict:
    """Chain plan -> approve -> design -> shell -> fan-out -> export for one
    brief, in-process. Raises StageError on the first stage that fails or
    reports an unmet acceptance condition (needsClarification, passed=False,
    non-zero export exit). Returns per-stage wall-clock timings and a
    dollar-cost breakdown on success."""
    run_id = run_id or fresh_run_id()

    # Validated HERE, before a single token is bought, even though only fan-out
    # uses it. `max_parallel_workers()` refuses a malformed
    # WEBGEN_FANOUT_MAX_WORKERS, and it used to be called inside `run_fanout` --
    # i.e. after intake, plan, design and shell had all been paid for. A typo in
    # one env var would have thrown away roughly $0.75 of prelude before saying
    # so, which is exactly the "dies AFTER partial spend" shape `portable.py`'s
    # own docstring condemns. Cheap to check, and the only honest place for it is
    # before the money starts. Found by the whole-branch review.
    max_parallel_workers()

    timings: dict[str, float] = {}
    overall_start = time.monotonic()

    started = time.monotonic()
    try:
        plan_result = plan_flow.run(run_id=run_id, user_brief=brief).wait()
    except kitaru.KitaruError as e:
        raise StageError("plan", str(e)) from e
    timings["plan"] = time.monotonic() - started
    if plan_result.get("needsClarification"):
        raise StageError("plan", f"needs clarification: {plan_result['questions']}")
    if plan_result.get("failed"):
        raise StageError("plan", plan_result.get("failureReport", "planner validation failed"))

    project_dir = GENERATED_DIR / run_id
    approve_plan(run_id)
    try:
        require_plan_approval(str(project_dir))
    except SystemExit as e:
        raise StageError("approve", str(e)) from e

    brief_json = (project_dir / "plan" / "brief.json").read_text(encoding="utf-8")
    started = time.monotonic()
    try:
        design_result = design_system_flow.run(run_id=run_id, brief_json=brief_json).wait()
    except kitaru.KitaruError as e:
        raise StageError("design", str(e)) from e
    timings["design"] = time.monotonic() - started
    if not design_result.get("passed"):
        raise StageError("design", design_result.get("failureReport", "design system agent failed"))

    siteplan_json = (project_dir / "plan" / "siteplan.json").read_text(encoding="utf-8")
    started = time.monotonic()
    try:
        shell_result = generate_shell_flow.run(
            run_id=run_id, brief_json=brief_json, siteplan_json=siteplan_json
        ).wait()
    except kitaru.KitaruError as e:
        raise StageError("shell", str(e)) from e
    timings["shell"] = time.monotonic() - started
    if not shell_result.get("passed"):
        raise StageError("shell", shell_result.get("failureReport", "shell agent failed"))

    # run_fanout is a plain function (not a kitaru flow) -- it spawns one
    # page_worker subprocess per route and does not raise on failure, it
    # returns passed=False (see fanout.py:110-117).
    started = time.monotonic()
    fanout_result = run_fanout(run_id)
    timings["fanout"] = time.monotonic() - started
    if not fanout_result.get("passed"):
        failed_workers = {
            slug: {"returncode": w["returncode"], "stderr_tail": w["stderr_tail"]}
            for slug, w in fanout_result.get("workers", {}).items()
            if w["returncode"] != 0
        }
        detail = {
            "gate_report": fanout_result.get("gate_report", {}),
            "failed_workers": failed_workers,
        }
        raise StageError("fanout", json.dumps(detail)[:6000])

    export_dir = GENERATED_DIR / f"{run_id}-export"
    started = time.monotonic()
    export_proc = _run_compiler_cli(["scripts/export.ts", str(project_dir), str(export_dir), "--clean"])
    timings["export"] = time.monotonic() - started
    if export_proc.returncode != 0:
        raise StageError("export", (export_proc.stderr or export_proc.stdout)[-2000:])

    timings["total"] = time.monotonic() - overall_start

    return {
        "run_id": run_id,
        "project_dir": str(project_dir),
        "export_dir": str(export_dir),
        "routes": fanout_result["routes"],
        # Loud on purpose. A section that exhausts its retries becomes a
        # FailedSectionPlaceholder and the site continues (pipeline 5.4) -- that
        # is the design, and the run genuinely did succeed. But a summary that
        # reports only success hides a page shipping without the section that
        # was the point of it, which is how a run gets called green while a
        # data grid is missing. Planned-minus-built, named.
        "degraded_sections": degraded_sections(project_dir),
        "timings_s": {k: round(v, 2) for k, v in timings.items()},
        "cost": cost_for_run(run_id),
    }


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.acceptance")
    parser.add_argument("--brief", required=True, help="One-line site brief.")
    parser.add_argument("--run-id", help="Reuse a specific run_id instead of generating a fresh one.")
    args = parser.parse_args()

    try:
        result = generate_site(args.brief, run_id=args.run_id)
    except StageError as e:
        print(json.dumps({"failed_stage": e.stage, "detail": e.detail}, indent=2, default=str))
        raise SystemExit(1) from e

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
