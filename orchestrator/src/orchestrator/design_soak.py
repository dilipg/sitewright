"""5.2 acceptance runner: design systems for the five 5.1 plan runs, then
(with --heroes) hero generation against each generated system — the
re-pointed pipeline consuming generated tokens/primitives as context.

Usage:
  uv run python -m orchestrator.design_soak            # design systems only
  uv run python -m orchestrator.design_soak --heroes   # hero soak (run after gallery screenshots)
"""

import argparse
import json

from orchestrator.design_pipeline import design_system_flow
from orchestrator.generate import DEFAULT_SECTION_BRIEF
from orchestrator.section_pipeline import GENERATED_DIR, generate_section_flow

RUNS = ["plan-01-saas", "plan-02-store", "plan-03-landing", "plan-04-agency", "plan-05-course"]


def page_brief_from_plan(run_id: str) -> str:
    brief = json.loads((GENERATED_DIR / run_id / "plan" / "brief.json").read_text(encoding="utf-8"))
    brand = brief["brand"]
    return (
        f"Landing page for {brand['name']}: {brand['oneLiner']} "
        f"Tone: {brand['tone']}. Audience: {brand['audience']}."
    )


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.design_soak")
    parser.add_argument("--heroes", action="store_true")
    args = parser.parse_args()

    for run_id in RUNS:
        if args.heroes:
            print(f"=== {run_id}: hero against the generated system...", flush=True)
            result = generate_section_flow.run(
                run_id=run_id,
                page_brief=page_brief_from_plan(run_id),
                section_brief=DEFAULT_SECTION_BRIEF,
                reuse_workspace=True,
            ).wait()
            print(
                f"=== {run_id}: hero passed={result['passed']} attempts={result['attempts']}",
                flush=True,
            )
        else:
            print(f"=== {run_id}: design system...", flush=True)
            brief_json = (GENERATED_DIR / run_id / "plan" / "brief.json").read_text(encoding="utf-8")
            result = design_system_flow.run(run_id=run_id, brief_json=brief_json).wait()
            print(
                f"=== {run_id}: ds passed={result.get('passed')} attempts={result.get('attempts')} "
                f"stage={result.get('stage', '-')}",
                flush=True,
            )


if __name__ == "__main__":
    main()
