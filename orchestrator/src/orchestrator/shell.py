"""Shell Agent CLI (build prompt 5.3).

Usage: uv run python -m orchestrator.shell --run-id plan-01-saas

Reads brief.json + siteplan.json from generated/<run-id>/plan/ (produced by
orchestrator.plan); requires the Design System Agent to have already run in
the same workspace (tokens.json + design-inventory.json present).
"""

import argparse
import json

from orchestrator.shell_pipeline import generate_shell_flow
from orchestrator.section_pipeline import GENERATED_DIR


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.shell")
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()

    plan_dir = GENERATED_DIR / args.run_id / "plan"
    brief_json = (plan_dir / "brief.json").read_text(encoding="utf-8")
    siteplan_json = (plan_dir / "siteplan.json").read_text(encoding="utf-8")

    handle = generate_shell_flow.run(
        run_id=args.run_id, brief_json=brief_json, siteplan_json=siteplan_json
    )
    result = handle.wait()
    print(json.dumps(result, indent=2, default=str))
    if not result.get("passed"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
