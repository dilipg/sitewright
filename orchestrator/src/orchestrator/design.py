"""Design System Agent CLI (build prompt 5.2).

Usage:
  uv run python -m orchestrator.design --run-id plan-01-saas

Reads the brief from generated/<run-id>/plan/brief.json (produced by
orchestrator.plan); generates tokens + the 15 primitives + the gallery page
into the same workspace.
"""

import argparse
import json

from orchestrator.design_pipeline import design_system_flow
from orchestrator.section_pipeline import GENERATED_DIR


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.design")
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()

    brief_path = GENERATED_DIR / args.run_id / "plan" / "brief.json"
    if not brief_path.exists():
        raise SystemExit(f"no brief at {brief_path}; run orchestrator.plan first")
    brief_json = brief_path.read_text(encoding="utf-8")

    handle = design_system_flow.run(run_id=args.run_id, brief_json=brief_json)
    result = handle.wait()
    print(json.dumps(result, indent=2, default=str))
    if not result.get("passed"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
