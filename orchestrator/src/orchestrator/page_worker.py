"""Page worker (build prompt 5.3, pipeline 2.5): generates one route's
sections sequentially, each as an independent generate_section_flow
execution — reused, not reinvented — with prior-section summaries carried
forward so hero and CTA don't contradict each other. Then assembles the
page (deterministic index.tsx + a project-level gate pass).

One worker process handles one route; the fan-out orchestrator (fanout.py)
spawns one OS process per route so pages run genuinely in parallel and a
crash in one worker cannot touch another's process memory.

Progress checkpointing: after each section completes (or exhausts retries),
its outcome is written to plan/page-progress-<slug>.json. A relaunched
worker (post-crash) skips sections already recorded there — each section's
OWN flow is independently resumable (proven in 3.1/4.1), so the page-level
"resume" is simply "don't redo what's already done".

Usage:
  uv run python -m orchestrator.page_worker --run-id X --route-slug Y
  uv run python -m orchestrator.page_worker --run-id X --route-slug Y --crash-after-section 2
"""

import argparse
import json
from pathlib import Path

from orchestrator.page_pipeline import assemble_page_flow, route_table_source
from orchestrator.section_pipeline import GENERATED_DIR, generate_section_flow


def progress_path(project_dir: Path, route_slug: str) -> Path:
    return project_dir / "plan" / f"page-progress-{route_slug}.json"


def load_progress(project_dir: Path, route_slug: str) -> dict:
    path = progress_path(project_dir, route_slug)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"sections": {}}


def save_progress(project_dir: Path, route_slug: str, progress: dict) -> None:
    progress_path(project_dir, route_slug).write_text(
        json.dumps(progress, indent=2), encoding="utf-8"
    )


def page_brief_text(brief: dict, route: dict) -> str:
    brand = brief["brand"]
    return (
        f"{route['title']} page for {brand['name']}: {brand['oneLiner']} "
        f"Tone: {brand['tone']}. Audience: {brand['audience']}."
    )


def run_route(run_id: str, route_slug: str, crash_after_section: int | None = None) -> dict:
    project_dir = GENERATED_DIR / run_id
    plan = json.loads((project_dir / "plan" / "siteplan.json").read_text(encoding="utf-8"))
    brief = json.loads((project_dir / "plan" / "brief.json").read_text(encoding="utf-8"))
    route = next(r for r in plan["routes"] if r["slug"] == route_slug)
    routes_table = route_table_source(plan["routes"])
    brief_text = page_brief_text(brief, route)

    progress = load_progress(project_dir, route_slug)
    prior_summaries: list[str] = []
    sections_meta: list[dict] = []

    for index, section in enumerate(route["sections"], start=1):
        slug = section["slug"]
        done = progress["sections"].get(slug)
        if done is not None:
            if done["passed"]:
                prior_summaries.append(f"- {done['component']}: {done['summary']}")
                sections_meta.append({"slug": slug, "component": done["component"]})
            else:
                sections_meta.append({"slug": slug, "failed": True})
            continue

        result = generate_section_flow.run(
            run_id=run_id,
            page_brief=brief_text,
            section_brief=section["brief"],
            reuse_workspace=True,
            route_slug=route_slug,
            route_path=route["path"],
            section_slug=slug,
            archetype=section["archetype"],
            prior_sections_text="\n".join(prior_summaries)
            or "(none — this is the first section on the page)",
            route_table_text=routes_table,
            assemble_index=False,
            crash_after_model_call=(crash_after_section == index),
        ).wait()

        if result["passed"]:
            meta = result["sectionMeta"]
            progress["sections"][slug] = {
                "passed": True,
                "component": meta["component"],
                "summary": meta["summary"],
            }
            prior_summaries.append(f"- {meta['component']}: {meta['summary']}")
            sections_meta.append({"slug": slug, "component": meta["component"]})
        else:
            progress["sections"][slug] = {"passed": False, "component": None, "summary": ""}
            sections_meta.append({"slug": slug, "failed": True})
        save_progress(project_dir, route_slug, progress)

    assembled = assemble_page_flow.run(
        run_id=run_id, project_dir=str(project_dir), route_slug=route_slug, sections=sections_meta
    ).wait()
    return {"route_slug": route_slug, "sections": sections_meta, "assembled": assembled}


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.page_worker")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--route-slug", required=True)
    parser.add_argument(
        "--crash-after-section",
        type=int,
        default=None,
        help="testing hook: hard-crash right after this section's (1-based) model call",
    )
    args = parser.parse_args()

    result = run_route(args.run_id, args.route_slug, args.crash_after_section)
    print(json.dumps(result, indent=2, default=str))
    print(f"PAGE_WORKER_RESULT {json.dumps(result, default=str)}")


if __name__ == "__main__":
    main()
