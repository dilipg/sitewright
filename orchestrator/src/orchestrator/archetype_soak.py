"""Per-archetype soak (build prompt 5.4: "soak each with 5 runs before
moving on"). Unlike M3's soak.py (one archetype, hero, proving the walking
skeleton), this proves each of the five new dedicated archetype templates
reliably produces gate-passing output across independent generations with
distinct briefs — the reliability claim a canonical example alone can't
make, since a single hand-reviewed example says nothing about how the
template holds up across the model's own sampling variance.

Runs against a REAL, already-generated full-15-primitive project (reuse_
workspace=True), not the 4-primitive fixture stub M3's soak.py uses — the
new archetypes' canonical examples compose primitives (Grid, Card, Icon,
Badge, Stack, Divider) the fixture doesn't have, so the fixture's stub
DESIGN CONTEXT would contradict the prompt's own example. All 5 personas
for a given archetype share ONE project run_id (so no repeat Design-System-
Agent spend — that reliability was already verified in M5.2, this soak is
scoped to archetype template quality alone) but each writes into its own
throwaway route slug (fan-out's write_section_only + scoped gate check,
build prompt 5.3) so cases never collide. Because every case shares a
run_id, the run log holds every case's events together — stats are
filtered by each case's own `section` id, never by run_id alone.

Does not run the invariant/editor suite (that's covered once per channel by
the invariant suite itself, build prompt 5.4 workstream 2/3) — success here
is "gates pass within the retry budget", the same bar M3's soak used.

Usage: uv run python -m orchestrator.archetype_soak <archetype>
"""

import json
import sys

from orchestrator.runlog import default_run_log_path, read_run_events
from orchestrator.section_pipeline import generate_section_flow

SECTION_BUDGET = 25_000
HARD_STOP = 3 * SECTION_BUDGET

PROJECT_RUN_ID = "plan-02-store-v7"

# Five distinct personas reused across every archetype's soak — enough
# brand/tone/audience variety to stress copy generation without needing 25
# independently-authored briefs.
PERSONAS: list[tuple[str, str]] = [
    ("ledgerly", "Ledgerly, bookkeeping software for freelancers who dread spreadsheets. Tone: plain-spoken, reassuring. Audience: solo freelancers."),
    ("bloomroot", "Bloom & Root, a houseplant delivery subscription with care coaching. Tone: playful, warm. Audience: urban apartment dwellers new to plants."),
    ("forgefit", "ForgeFit, a strength-programming app with coach review. Tone: bold, no-nonsense. Audience: serious lifters plateauing on their own."),
    ("quietdesk", "QuietDesk, noise analytics for open-plan offices. Tone: calm, professional. Audience: workplace managers."),
    ("saffronlane", "Saffron Lane, meal kits of family Indian recipes. Tone: rich, family-warm. Audience: busy parents missing home cooking."),
]

SECTION_BRIEFS: dict[str, str] = {
    "feature-grid": "A feature grid covering this product's 3-4 standout capabilities.",
    "cta-band": "The page's closing call-to-action, inviting the visitor to start.",
    "pricing-tiers": "A 3-tier pricing section (a free/entry tier, a highlighted mid tier, a top tier) matching this product's likely price point.",
    "faq-accordion": "An FAQ section answering the questions most likely to block a signup for this product.",
    "social-proof": "A testimonials section with 3 short customer quotes for this product.",
}


def run_stats(run_id: str, section_id: str) -> dict:
    """Filtered by section_id, not just run_id: every persona in a soak
    shares one project run_id, so the run log holds every case's events.

    Token/attempt counts here are USAGE TELEMETRY ONLY, scoped to the most
    recent flow execution (grouped by the exec_id embedded in each event's
    checkpoint_ref) so a re-soak of an already-tested route slug (template
    fixed, re-run against the same shared project) doesn't silently sum in
    a stale prior run's events. Pass/fail is NEVER read from here — the
    caller uses the flow's own `result["passed"]`, the only source that
    can't be polluted by old events sharing this section id."""
    events = [e for e in read_run_events(default_run_log_path(run_id)) if e.get("section") == section_id]
    generated = [e for e in events if e["event_type"] == "section.generated"]
    if generated:
        latest_exec = generated[-1]["checkpoint_ref"].split("/")[0]
        generated = [e for e in generated if e["checkpoint_ref"].startswith(latest_exec)]
    usage = {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0}
    for event in generated:
        u = event["usage"]
        usage["input"] += u["input_tokens"]
        usage["output"] += u["output_tokens"]
        usage["cache_read"] += u["cache_read_input_tokens"]
        usage["cache_write"] += u["cache_creation_input_tokens"]
    return {"attempts": len(generated), "total_tokens": sum(usage.values()), **usage}


def run_archetype_soak(archetype: str) -> list[dict]:
    if archetype not in SECTION_BRIEFS:
        raise KeyError(f"no soak section brief configured for archetype {archetype!r}")
    section_brief = SECTION_BRIEFS[archetype]

    rows = []
    for persona_slug, brand_brief in PERSONAS:
        route_slug = f"soak-{archetype}-{persona_slug}"
        section_id = f"{route_slug}.{archetype}"
        print(f"=== {section_id}: generating...", flush=True)
        handle = generate_section_flow.run(
            run_id=PROJECT_RUN_ID,
            page_brief=f"Landing page for {brand_brief}",
            section_brief=section_brief,
            reuse_workspace=True,
            route_slug=route_slug,
            section_slug=archetype,
            archetype=archetype,
            assemble_index=False,
        )
        result = handle.wait()
        stats = run_stats(PROJECT_RUN_ID, section_id)

        if stats["total_tokens"] > HARD_STOP:
            print(f"ABORT: {section_id} used {stats['total_tokens']} tokens (> 3x budget).", flush=True)
            break

        # gates_passed is set from result LAST so it can never be shadowed
        # by a same-named key elsewhere in this dict literal.
        row = {"section_id": section_id, **stats, "gates_passed": bool(result["passed"])}
        if not result["passed"]:
            row["failure_report"] = result.get("failure_report", "")
        rows.append(row)
        print(
            f"=== {section_id}: gates={row['gates_passed']} attempts={row['attempts']} "
            f"tokens={row['total_tokens']}",
            flush=True,
        )
    return rows


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in SECTION_BRIEFS:
        print(f"Usage: uv run python -m orchestrator.archetype_soak <{'|'.join(SECTION_BRIEFS)}>")
        raise SystemExit(2)
    archetype = sys.argv[1]
    rows = run_archetype_soak(archetype)
    passed = sum(1 for r in rows if r["gates_passed"])
    print(json.dumps(rows, indent=2, default=str))
    print(f"=== {archetype}: {passed}/{len(rows)} gate-passed")
    if passed < len(rows):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
