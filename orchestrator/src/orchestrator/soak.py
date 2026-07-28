"""Walking-skeleton soak (build prompt 3.4, milestone 3 exit criteria):
10 generation runs with distinct briefs; for each — gates within the retry
budget, then the invariant suite drives the editor against the generated
project (style edit -> export -> pixel diff). Emits the report skeleton at
docs/reports/m3-soak.md.

Standing rule 5: aborts if any run exceeds 3x the 25k section budget.

Usage: uv run python -m orchestrator.soak
"""

import json
import os
import subprocess
from pathlib import Path

from orchestrator.fixture_context import FIXTURE_DIR
from orchestrator.generate import DEFAULT_SECTION_BRIEF
from orchestrator.runlog import default_run_log_path, read_run_events
from orchestrator.section_pipeline import GENERATED_DIR, REPO_ROOT, generate_section_flow

SECTION_BUDGET = 25_000
HARD_STOP = 3 * SECTION_BUDGET

BRIEFS: list[tuple[str, str]] = [
    ("soak-01-ledgerly", "Landing page for Ledgerly, bookkeeping software for freelancers who dread spreadsheets. Tone: plain-spoken, reassuring. Audience: solo freelancers."),
    ("soak-02-bloomroot", "Landing page for Bloom & Root, a houseplant delivery subscription with care coaching. Tone: playful, warm. Audience: urban apartment dwellers new to plants."),
    ("soak-03-forgefit", "Landing page for ForgeFit, a strength-programming app with coach review. Tone: bold, no-nonsense. Audience: serious lifters plateauing on their own."),
    ("soak-04-quietdesk", "Landing page for QuietDesk, noise analytics for open-plan offices. Tone: calm, professional. Audience: workplace managers."),
    ("soak-05-saffronlane", "Landing page for Saffron Lane, meal kits of family Indian recipes. Tone: rich, family-warm. Audience: busy parents missing home cooking."),
    ("soak-06-northstar", "Landing page for Northstar Tutors, live SAT prep in small groups. Tone: confident, encouraging. Audience: parents of stressed high-schoolers."),
    ("soak-07-driftless", "Landing page for Driftless Kayaks, handmade wooden kayaks. Tone: heritage craftsmanship, unhurried. Audience: paddlers who care about the craft."),
    ("soak-08-pixelframe", "Landing page for Pixelframe, portfolio hosting for professional photographers. Tone: minimal, visual-first. Audience: working photographers."),
    ("soak-09-copperkettle", "Landing page for Copperkettle, a single-origin tea subscription. Tone: cozy, literary. Audience: readers who take tea seriously."),
    ("soak-10-vaultic", "Landing page for Vaultic, a family password manager. Tone: trustworthy, simple. Audience: non-technical households."),
]


def ensure_node_modules(project_dir: Path) -> None:
    """Junction the fixture's node_modules so the preview server and export
    verification build can run against the generated project."""
    target = project_dir / "node_modules"
    if not target.exists():
        subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(target), str(FIXTURE_DIR / "node_modules")],
            check=True,
            capture_output=True,
        )


def run_invariant(project_dir: Path, export_dir: Path) -> bool:
    env = dict(os.environ)
    env["WG_PROJECT_DIR"] = str(project_dir)
    env["WG_EXPORT_DIR"] = str(export_dir)
    result = subprocess.run(
        ["cmd", "/c", "npx", "playwright", "test", "invariant"],
        cwd=REPO_ROOT / "editor",
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=900,
    )
    return result.returncode == 0


def run_stats(run_id: str) -> dict:
    events = read_run_events(default_run_log_path(run_id))
    generated = [e for e in events if e["event_type"] == "section.generated"]
    validated = [e for e in events if e["event_type"] == "section.validated"]
    usage = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    for event in generated:
        u = event["usage"]
        usage["input"] += u["input_tokens"]
        usage["output"] += u["output_tokens"]
        usage["cache_read"] += u["cache_read_input_tokens"]
        usage["cache_write"] += u["cache_creation_input_tokens"]
    return {
        "attempts": len(generated),
        "gates_passed": any(v["gate_results"]["passed"] for v in validated),
        "total_tokens": sum(usage.values()),
        **usage,
    }


def main() -> None:
    rows = []
    for run_id, brief in BRIEFS:
        print(f"=== {run_id}: generating...", flush=True)
        handle = generate_section_flow.run(
            run_id=run_id, page_brief=brief, section_brief=DEFAULT_SECTION_BRIEF
        )
        result = handle.wait()
        stats = run_stats(run_id)

        if stats["total_tokens"] > HARD_STOP:
            print(f"ABORT: {run_id} used {stats['total_tokens']} tokens (> 3x budget).", flush=True)
            break

        invariant_ok = False
        if result["passed"]:
            project_dir = GENERATED_DIR / run_id
            ensure_node_modules(project_dir)
            print(f"=== {run_id}: invariant suite...", flush=True)
            invariant_ok = run_invariant(project_dir, GENERATED_DIR / f"{run_id}-export")

        row = {
            "run_id": run_id,
            "gates_passed": bool(result["passed"]),
            "invariant_passed": invariant_ok,
            **stats,
        }
        rows.append(row)
        print(f"=== {run_id}: gates={row['gates_passed']} attempts={row['attempts']} "
              f"tokens={row['total_tokens']} invariant={invariant_ok}", flush=True)

    write_report(rows)
    print("soak complete", flush=True)


def write_report(rows: list[dict]) -> None:
    fully_green = sum(1 for r in rows if r["gates_passed"] and r["invariant_passed"])
    mean_tokens = round(sum(r["total_tokens"] for r in rows) / max(len(rows), 1))
    lines = [
        "# M3 Walking-Skeleton Soak Report",
        "",
        f"10 generation runs with distinct briefs (build prompt 3.4). Section budget: {SECTION_BUDGET:,} tokens; ceiling 2x.",
        "",
        "| run | gates | attempts | invariant | uncached in | cache read | cache write | out | total tokens |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['run_id']} | {'PASS' if r['gates_passed'] else 'FAIL'} | {r['attempts']} "
            f"| {'PASS' if r['invariant_passed'] else 'FAIL'} | {r['input']:,} | {r['cache_read']:,} "
            f"| {r['cache_write']:,} | {r['output']:,} | {r['total_tokens']:,} |"
        )
    lines += [
        "",
        f"**Fully green: {fully_green}/{len(rows)}** (exit bar: >= 9/10)",
        "",
        f"**Mean section cost: {mean_tokens:,} tokens** = {mean_tokens / SECTION_BUDGET:.2f}x budget (bar: <= 2x)",
        "",
        "## Worst three outputs",
        "",
        "(reviewed below)",
        "",
    ]
    report = REPO_ROOT / "docs" / "reports" / "m3-soak.md"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    (REPO_ROOT / "orchestrator" / "runlog" / "soak-summary.json").write_text(
        json.dumps(rows, indent=2), encoding="utf-8"
    )


if __name__ == "__main__":
    main()
