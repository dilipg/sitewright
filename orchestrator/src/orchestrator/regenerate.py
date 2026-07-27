"""Section regeneration CLI (build prompt 4.1, pipeline 5.5): forks the
recorded generation run at the generate_section checkpoint via Kitaru
replay-with-overrides, with the REGEN BLOCK (old source, manifest entries,
overridden node IDs, user instruction) injected through flow overrides.
Cost of a regen ≈ cost of one section.

Usage:
  uv run python -m orchestrator.regenerate --run-id soak-01-ledgerly \
      --instruction "change the headline tone to playful"
"""

import argparse
import json

from orchestrator.runlog import default_run_log_path, read_run_events
from orchestrator.section_pipeline import GENERATED_DIR, build_regen_block, generate_section_flow


def recorded_exec_id(run_id: str) -> str:
    """The original run's exec id, recovered from the run log's checkpoint refs."""
    events = read_run_events(default_run_log_path(run_id))
    generated = [e for e in events if e["event_type"] == "section.generated"]
    if not generated:
        raise SystemExit(f"no recorded generation for run '{run_id}'")
    return generated[-1]["checkpoint_ref"].split("/")[0]


def regenerate_section(run_id: str, section: str, instruction: str) -> dict:
    """Forks the recorded run and returns the outcome summary. Shared by the
    CLI, the preview server's regen endpoint, and the 4.3 stress suite."""
    project_dir = GENERATED_DIR / run_id
    regen_block, overridden_ids = build_regen_block(project_dir, section, instruction)
    exec_id = recorded_exec_id(run_id)
    print(f"forking {exec_id} at generate_section; overridden ids: {overridden_ids}", flush=True)

    events_before = len(read_run_events(default_run_log_path(run_id)))
    submission = generate_section_flow.replay(
        exec_id,
        at="generate_section",
        flow_overrides={
            "regen_block": regen_block,
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


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.regenerate")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--instruction", required=True)
    parser.add_argument("--section", default="home.hero")
    args = parser.parse_args()

    summary = regenerate_section(args.run_id, args.section, args.instruction)
    print(json.dumps(summary, indent=2))
    # machine-readable single line for the preview server's regen endpoint
    print(f"REGEN_RESULT {json.dumps(summary)}")


if __name__ == "__main__":
    main()
