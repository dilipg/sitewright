"""Single-section generation CLI (build prompt 3.3).

Usage:
  uv run python -m orchestrator.generate --run-id m33-a \
      --brief "Landing page for ..." \
      [--section-brief "..."] [--inject "..."]

--inject appends an instruction to the section brief — used to force a
gate-failing generation and exercise the bounded-retry path.
"""

import argparse
import json

from orchestrator.plan_pipeline import require_plan_approval
from orchestrator.section_pipeline import GENERATED_DIR, generate_section_flow

DEFAULT_SECTION_BRIEF = (
    "Bold opening hero introducing the product with a primary trial CTA and a "
    "secondary demo CTA."
)


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.generate")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--brief", required=True)
    parser.add_argument("--section-brief", default=DEFAULT_SECTION_BRIEF)
    parser.add_argument("--inject", default="", help="extra instruction appended to the section brief (testing hook)")
    args = parser.parse_args()

    # plan approval gates generation spend (pipeline 2.2); plan-less
    # canned-brief runs (M3 skeleton, soak, stress) remain allowed
    require_plan_approval(GENERATED_DIR / args.run_id)

    section_brief = args.section_brief
    if args.inject:
        section_brief = f"{section_brief} {args.inject}"

    handle = generate_section_flow.run(
        run_id=args.run_id, page_brief=args.brief, section_brief=section_brief
    )
    result = handle.wait()
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
