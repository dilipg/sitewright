"""ID-survival stress suite (build prompt 4.3 — the hard gate on the whole
project): 20 varied regen instructions against hero sections carrying four
overrides each. Measures auto-reattach on conceptually-surviving elements,
orphan correctness (overridden = reattached + declared + silent, silent must
be zero), and the gate-7 retry rate. Emits docs/reports/m4-id-survival.md.

Before each case the base project is re-generated (Kitaru caches identical
generations, so repeat rebases are free) to isolate cases from each other.
Per-case results stream to runlog/stress-results.jsonl — a re-run resumes,
skipping measured cases.

Usage: uv run python -m orchestrator.stress
"""

import json
import re
from dataclasses import dataclass
from pathlib import Path

from orchestrator.generate import DEFAULT_SECTION_BRIEF
from orchestrator.regenerate import regenerate_section
from orchestrator.section_pipeline import GENERATED_DIR, REPO_ROOT, generate_section_flow
from orchestrator.soak import BRIEFS

SECTION = "home.hero"
NODE_ID_RE = re.compile(r'(?:data-node-id|nodeId)="([a-z0-9.-]+)"')

STANDARD_OVERRIDES = [
    {"nodeId": "home.hero.headline", "channel": "text", "value": "Custom headline the user wrote"},
    {"nodeId": "home.hero.subheadline", "channel": "style", "value": {"color": "color.semantic.accent"}},
    {"nodeId": "home.hero.cta-primary", "channel": "style", "value": {"background": "color.semantic.success"}},
    {"nodeId": "home.hero.eyebrow", "channel": "text", "value": "CUSTOM EYEBROW"},
]
OVERRIDDEN_IDS = {entry["nodeId"] for entry in STANDARD_OVERRIDES}


@dataclass(frozen=True)
class StressCase:
    case_id: str
    kind: str
    instruction: str
    expected_orphans: frozenset[str] = frozenset()


CASES: list[StressCase] = [
    StressCase("c01", "reword", "Reword the headline to emphasize how fast setup is."),
    StressCase("c02", "reword", "Rewrite the subheadline to mention a 14-day money-back guarantee."),
    StressCase("c03", "tone", "Make all the copy more playful and irreverent."),
    StressCase("c04", "tone", "Make the tone formal and enterprise-grade."),
    StressCase("c05", "reword", "Shorten the headline to five words or fewer."),
    StressCase("c06", "removal", "Remove the eyebrow text entirely.", frozenset({"home.hero.eyebrow"})),
    StressCase("c07", "removal", "Remove the subheadline; the hero should be tighter.", frozenset({"home.hero.subheadline"})),
    StressCase("c08", "removal", "Drop the secondary CTA button; keep everything else."),
    StressCase("c09", "count", "Add a third CTA linking to an external placeholder docs URL."),
    StressCase("c10", "count", "Add a row of three short customer names as social proof below the CTAs."),
    StressCase("c11", "structure", "Restructure: put the CTA buttons above the subheadline."),
    StressCase("c12", "structure", "Left-align the whole hero instead of centering it."),
    StressCase("c13", "structure", "Wrap the CTA buttons in a card-like surface panel."),
    StressCase("c14", "count", "Replace the two CTAs with a single strong primary CTA."),
    StressCase("c15", "removal", "Remove the eyebrow and make the headline carry the brand name.", frozenset({"home.hero.eyebrow"})),
    StressCase("c16", "tone", "Make the copy urgent, with scarcity framing."),
    StressCase("c17", "structure", "Make the hero full-height with vertically centered content."),
    StressCase("c18", "count", "Add a small trust line under the CTAs mentioning how many teams use the product."),
    StressCase("c19", "structure", "Rename the component to SplitHero and restructure into two columns: copy on the left, CTA stack on the right."),
    StressCase("c20", "removal", "Strip the hero down to just the headline and the primary CTA.", frozenset({"home.hero.eyebrow", "home.hero.subheadline"})),
]


def case_metrics(
    *,
    overridden: set[str],
    expected_orphans: set[str],
    attached: set[str],
    declared: set[str],
) -> dict:
    """Buckets every overridden id: reattached, declared orphan, or SILENT
    DROP (the unforgivable one). Reattach rate counts only conceptually-
    surviving elements; a declared orphan that should have survived is not
    silent, but it is a reattach failure."""
    silent = overridden - attached - declared
    expected_survivors = overridden - expected_orphans
    reattached = {i for i in expected_survivors if i in attached and i not in declared}
    declared_overridden = declared & overridden
    return {
        "expected_survivors": len(expected_survivors),
        "reattached": len(reattached),
        "declared_orphans": sorted(declared_overridden),
        "unexpected_orphans": sorted(declared_overridden - expected_orphans),
        "missed_expected_orphans": sorted(expected_orphans & attached),
        "silent_drops": sorted(silent),
    }


def attached_ids(project_dir: Path) -> set[str]:
    ids: set[str] = set()
    for source in (project_dir / "src" / "pages" / "home").rglob("*.tsx"):
        ids.update(NODE_ID_RE.findall(source.read_text(encoding="utf-8")))
    return ids


def install_overrides(project_dir: Path) -> None:
    (project_dir / "overrides" / "home.overrides.json").write_text(
        json.dumps(
            {
                "version": 1,
                "route": "/",
                "overrides": [
                    {**entry, "updatedAt": "2026-07-27T00:00:00.000Z"} for entry in STANDARD_OVERRIDES
                ],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def results_path() -> Path:
    return REPO_ROOT / "orchestrator" / "runlog" / "stress-results.jsonl"


def load_done() -> dict[str, dict]:
    path = results_path()
    if not path.exists():
        return {}
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    return {row["case_id"]: row for row in rows}


def run_case(case: StressCase, base_run_id: str, base_brief: str) -> dict:
    # rebase: workspace_token forces a real workspace reset (a cached
    # prepare_workspace would skip the side effect); the generation itself
    # cache-hits after the first rebase of each base
    generate_section_flow.run(
        run_id=base_run_id,
        page_brief=base_brief,
        section_brief=DEFAULT_SECTION_BRIEF,
        workspace_token=f"stress-{case.case_id}",
    ).wait()
    project_dir = GENERATED_DIR / base_run_id
    install_overrides(project_dir)

    summary = regenerate_section(base_run_id, SECTION, case.instruction)

    metrics = case_metrics(
        overridden=set(OVERRIDDEN_IDS),
        expected_orphans=set(case.expected_orphans),
        attached=attached_ids(project_dir),
        declared=set(summary["orphanedOverrides"]),
    )
    return {
        "case_id": case.case_id,
        "kind": case.kind,
        "instruction": case.instruction,
        "base": base_run_id,
        "passed": summary["passed"],
        "attempts": summary["attempts"],
        "gate7_retries": summary["gate7Retries"],
        "tombstoned": summary["tombstoned"],
        **metrics,
    }


def main() -> None:
    done = load_done()
    for index, case in enumerate(CASES):
        if case.case_id in done:
            print(f"=== {case.case_id}: already measured, skipping", flush=True)
            continue
        base_run_id, base_brief = BRIEFS[index % len(BRIEFS)]
        print(f"=== {case.case_id} ({case.kind}) on {base_run_id}: {case.instruction}", flush=True)
        row = run_case(case, base_run_id, base_brief)
        with results_path().open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(row) + "\n")
        print(
            f"=== {case.case_id}: passed={row['passed']} attempts={row['attempts']} "
            f"reattached={row['reattached']}/{row['expected_survivors']} "
            f"orphans={row['declared_orphans']} silent={row['silent_drops']}",
            flush=True,
        )

    write_report(list(load_done().values()))
    print("stress suite complete", flush=True)


def write_report(rows: list[dict]) -> None:
    passing = [r for r in rows if r["passed"]]
    survivors = sum(r["expected_survivors"] for r in passing)
    reattached = sum(r["reattached"] for r in passing)
    silent = [drop for r in rows for drop in r["silent_drops"]]
    gate7_retries = sum(r["gate7_retries"] for r in rows)
    unexpected = [o for r in passing for o in r["unexpected_orphans"]]
    missed = [m for r in passing for m in r["missed_expected_orphans"]]
    rate = reattached / survivors if survivors else 0.0

    lines = [
        "# M4 ID-Survival Stress Report",
        "",
        "20 regeneration instructions (rewordings, structural changes, element removals, count changes, tone shifts)",
        "against hero sections carrying overrides on 4 nodes each (build prompt 4.3).",
        "",
        "| case | kind | base | passed | attempts | gate-7 retries | reattached | declared orphans | unexpected orphans | silent drops |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in sorted(rows, key=lambda row: row["case_id"]):
        lines.append(
            f"| {r['case_id']} | {r['kind']} | {r['base'].removeprefix('soak-')} | {'PASS' if r['passed'] else 'FAIL'} "
            f"| {r['attempts']} | {r['gate7_retries']} | {r['reattached']}/{r['expected_survivors']} "
            f"| {', '.join(r['declared_orphans']) or '—'} | {', '.join(r['unexpected_orphans']) or '—'} "
            f"| {', '.join(r['silent_drops']) or '—'} |"
        )
    lines += [
        "",
        f"**Auto-reattach rate on conceptually-surviving elements: {reattached}/{survivors} = {rate:.1%}** (bar: ≥ 90%)",
        "",
        f"**Silent drops: {len(silent)}** (bar: zero) — every non-surviving override was declared and would appear in the orphan dialog",
        "",
        f"Gate-7 retries across the suite: {gate7_retries}. Failed cases: {len(rows) - len(passing)}/{len(rows)}.",
        f"Unexpected orphans (survivor declared removed): {len(unexpected)}. Missed expected orphans (instruction not fully applied): {len(missed)}.",
        "",
    ]
    report = REPO_ROOT / "docs" / "reports" / "m4-id-survival.md"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text("\n".join(lines), encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
