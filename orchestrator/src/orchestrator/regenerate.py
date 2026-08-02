"""Regeneration CLI (build prompt 4.1, pipeline 5.5; page scope added in 7.9):
forks the recorded generation run at the generate_section checkpoint via Kitaru
replay-with-overrides, with the REGEN BLOCK (old source, manifest entries,
overridden node IDs, user instruction) injected through flow overrides.
Cost of a section regen ≈ cost of one section; a page regen ≈ that times the
number of sections on the route.

Usage:
  # one section
  uv run python -m orchestrator.regenerate --run-id soak-01-ledgerly \
      --section home.hero --instruction "change the headline tone to playful"

  # every section on a route ("redo this whole page", PRD section 4)
  uv run python -m orchestrator.regenerate --run-id soak-01-ledgerly \
      --route home --instruction "warmer, less corporate tone throughout"
"""

import argparse
import json
from pathlib import Path

from orchestrator.placeholder_shield import shield
from orchestrator.runlog import default_run_log_path, read_run_events
from orchestrator.section_pipeline import GENERATED_DIR, build_regen_block, generate_section_flow


def recorded_exec_id(run_id: str, section: str) -> str:
    """The exec id of THIS SECTION's own recorded generation, recovered from the
    run log's checkpoint refs.

    Filtering by section is load-bearing. Every section of a run shares one
    run_id and therefore one log, so taking the last `section.generated` event
    outright (as this did until milestone 7.1) returns whichever section
    happened to finish last — and the replay then regenerates THAT section
    while the caller's regen block describes a different one. Harmless while a
    run only ever held one section (M3/M4 soak and stress runs were all
    home.hero); silently wrong from 5.3's multi-section fan-out onward.

    Observed live: regenerating `shop.product-grid` replayed `home.cta-band`'s
    execution instead, leaving shop untouched and writing a second home
    component whose literal ids collided with the manifest's existing ones.
    """
    events = read_run_events(default_run_log_path(run_id))
    generated = [
        e
        for e in events
        if e["event_type"] == "section.generated" and e.get("section") == section
    ]
    if not generated:
        known = sorted(
            {
                e.get("section", "")
                for e in events
                if e["event_type"] == "section.generated" and e.get("section")
            }
        )
        raise SystemExit(
            f"no recorded generation for section '{section}' in run '{run_id}'"
            + (f"; this run generated: {', '.join(known)}" if known else "")
        )
    return generated[-1]["checkpoint_ref"].split("/")[0]


def regenerate_section(run_id: str, section: str, instruction: str) -> dict:
    """Forks the recorded run and returns the outcome summary. Shared by the
    CLI, the preview server's regen endpoint, and the 4.3 stress suite."""
    project_dir = GENERATED_DIR / run_id
    regen_block, overridden_ids = build_regen_block(project_dir, section, instruction)
    exec_id = recorded_exec_id(run_id, section)
    print(f"forking {exec_id} at generate_section; overridden ids: {overridden_ids}", flush=True)

    events_before = len(read_run_events(default_run_log_path(run_id)))
    submission = generate_section_flow.replay(
        exec_id,
        at="generate_section",
        flow_overrides={
            # The regen block embeds the section's OWN existing source, which
            # for any list-based archetype contains `${nodeId}` -- shielded so
            # Kitaru's substitution pass cannot reject the replay outright
            # (see placeholder_shield).
            "regen_block": shield(regen_block),
            "regen_overridden_ids": overridden_ids,
        },
    )
    if submission.failures:
        for failure in submission.failures:
            print(json.dumps(failure.__dict__, indent=2, default=str))
        raise RuntimeError(f"replay submission failed for {run_id}")

    # outcome from the run log (the replay appends to the same run's log)
    events = read_run_events(default_run_log_path(run_id))[events_before:]
    validated = [e for e in events if e["event_type"] == "section.validated"]
    generated = [e for e in events if e["event_type"] == "section.generated"]
    last = validated[-1]
    manifest = json.loads((project_dir / "manifest.json").read_text(encoding="utf-8"))
    tombstoned = sorted(
        node_id
        for node_id, node in manifest["nodes"].items()
        if (node_id == section or node_id.startswith(f"{section}.")) and node["status"] == "tombstoned"
    )
    gate7_failures = [
        f
        for event in validated
        for f in event["gate_results"]["failures"]
        if f.get("gate") == 7
    ]
    return {
        "passed": last["gate_results"]["passed"],
        "attempts": len(generated),
        "orphanedOverrides": last.get("declared_orphans", []),
        "overriddenIds": overridden_ids,
        "tombstoned": tombstoned,
        "gate7Retries": len(gate7_failures),
        "failureReport": ""
        if last["gate_results"]["passed"]
        else "\n".join(f["message"] for f in last["gate_results"]["failures"]),
    }


def route_sections(project_dir: Path, route: str) -> list[str]:
    """The route's ACTIVE section roots, in manifest registration order.

    Registration order is the order the page worker generated them, which is
    the order they were assembled into index.tsx -- so regenerating in this
    order walks the page top to bottom. A tombstoned section is skipped: it no
    longer exists in the source, so there is nothing to replay for it.
    """
    manifest = json.loads((project_dir / "manifest.json").read_text(encoding="utf-8"))
    return [
        node_id
        for node_id, node in manifest["nodes"].items()
        if node_id.startswith(f"{route}.")
        and node_id.count(".") == 1
        and node["status"] == "active"
    ]


def regenerate_page(run_id: str, route: str, instruction: str) -> dict:
    """Page-level regeneration (PRD section 4, last paragraph): "reuses the same
    flow at page granularity".

    Literally the same flow -- this loops `regenerate_section`, so a page regen
    inherits the replay-with-overrides fork, gate 7 ID survival and the orphan
    declaration unchanged, and there is no second code path that could drift
    from the section one.

    SEQUENTIAL, not a fan-out. Every section on a route writes into the same
    page directory and the same manifest, and contract section 2 gives that
    directory exactly one writer; the manifest service's cross-process lock
    would serialize the writes anyway, but only after two forks had already
    raced to produce them. Sequential also means a mid-page failure leaves a
    coherent prefix rather than an arbitrary subset.

    Per 7.1: each section forks its OWN recorded execution (there is no single
    page-level exec id to replay), and each regen block goes through the
    placeholder shield.
    """
    sections = route_sections(GENERATED_DIR / run_id, route)
    if not sections:
        raise SystemExit(f"no active sections on route '{route}' in run '{run_id}'")

    print(f"regenerating {len(sections)} sections on '{route}': {', '.join(sections)}", flush=True)
    per_section: dict[str, dict] = {}
    for section in sections:
        per_section[section] = regenerate_section(run_id, section, instruction)

    # Aggregated so the editor surfaces ONE outcome for the page: orphans
    # appear once for the route rather than once per section (PRD 4.3's dialog
    # is a decision point, and asking the same question N times per page turns
    # a decision into a wall of prompts).
    def merged(key: str) -> list[str]:
        return sorted({value for result in per_section.values() for value in result[key]})

    failures = [
        f"{section}: {result['failureReport']}"
        for section, result in per_section.items()
        if not result["passed"]
    ]
    return {
        "passed": all(result["passed"] for result in per_section.values()),
        "route": route,
        "sections": sections,
        "attempts": sum(result["attempts"] for result in per_section.values()),
        "orphanedOverrides": merged("orphanedOverrides"),
        "overriddenIds": merged("overriddenIds"),
        "tombstoned": merged("tombstoned"),
        "gate7Retries": sum(result["gate7Retries"] for result in per_section.values()),
        "failureReport": "\n".join(failures),
        "perSection": {section: result["passed"] for section, result in per_section.items()},
    }


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.regenerate")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--instruction", required=True)
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--section", help="regenerate one section (default: home.hero)")
    scope.add_argument("--route", help="regenerate every active section on a route")
    args = parser.parse_args()

    summary = (
        regenerate_page(args.run_id, args.route, args.instruction)
        if args.route is not None
        else regenerate_section(args.run_id, args.section or "home.hero", args.instruction)
    )
    print(json.dumps(summary, indent=2))
    # machine-readable single line for the preview server's regen endpoint
    print(f"REGEN_RESULT {json.dumps(summary)}")


if __name__ == "__main__":
    main()
