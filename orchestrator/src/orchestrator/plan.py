"""Plan CLI (build prompt 5.1): intake + site planner.

Usage:
  uv run python -m orchestrator.plan --run-id X --brief "..."
  uv run python -m orchestrator.plan --run-id X --brief "..." --answers "..."

Exit codes: 0 plan written (awaiting approval) / 3 clarification needed
(questions printed; rerun with --answers) / 1 planning failed.
"""

import argparse
import json

from orchestrator.plan_pipeline import plan_flow


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.plan")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--brief", required=True)
    parser.add_argument("--answers", default="", help="answers to the clarifying questions (second round)")
    args = parser.parse_args()

    handle = plan_flow.run(
        run_id=args.run_id, user_brief=args.brief, clarification_answers=args.answers
    )
    result = handle.wait()
    print(json.dumps(result, indent=2, default=str))
    if result.get("needsClarification"):
        raise SystemExit(3)
    if result.get("failed"):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
