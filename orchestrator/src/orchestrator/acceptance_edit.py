"""The post-generation half of an end-to-end run: the EDITING loop.

`acceptance.py` chains plan -> approve -> design -> shell -> fan-out -> export,
which proves a site can be generated. It stops there, so nothing in it touches
what the product is actually for: editing that site and regenerating parts of it
without losing the edits. This module is the other half, and it is what closes
the two verification gaps 7.9 and 7.6 recorded (page regen and add-a-section had
only ever run against mocks).

Run against a real generated project, in order:

  1. seed overrides across every channel, derived from that project's own
     manifest (there is no fixed node id to hardcode — every site differs)
  2. regenerate ONE section          -> 7.1's path, already proven live
  3. regenerate a whole PAGE         -> 7.9
  4. ADD a section                   -> 7.6
  5. re-export                       -> typecheck + all seven gates + build

The load-bearing assertion is the same one at every step, and it is the
product's one unforgivable failure inverted: **every overridden node that still
exists must still carry its override.** An override on a node the model
legitimately removed is an orphan, which is a correct outcome (PRD 4.3) — so the
check is not "zero orphans", it is "no override was lost while its node
survived". Anything else would either pass on a regen that quietly dropped
edits, or fail on one that behaved correctly.

Overrides are written directly here rather than through the editor. That is the
same test-infrastructure precedent `stress.install_overrides` set for the 4.3
suite; the ownership rule (only the editor writes overrides) is about the
product path, and this file is a harness.
"""

import argparse
import json
import time
from pathlib import Path

from orchestrator.acceptance import StageError
from orchestrator.add_section import add_section
from orchestrator.regenerate import regenerate_page, regenerate_section, route_sections
from orchestrator.section_pipeline import GENERATED_DIR, _run_compiler_cli

STAMP = "2026-08-02T00:00:00.000Z"


def _manifest(project_dir: Path) -> dict:
    return json.loads((project_dir / "manifest.json").read_text(encoding="utf-8"))


def _active(manifest: dict) -> dict:
    return {i: n for i, n in manifest["nodes"].items() if n["status"] == "active"}


def pick_route(project_dir: Path) -> str:
    """The route to exercise: the one with the most sections.

    More sections means more for a page regen to get wrong and a real choice of
    override targets. Ties go to whichever the manifest registered first, which
    is deterministic.
    """
    manifest = _manifest(project_dir)
    routes = {node_id.split(".")[0] for node_id in _active(manifest)}
    if not routes:
        raise StageError("edit:setup", "the project has no active manifest nodes")
    return max(routes, key=lambda route: len(route_sections(project_dir, route)))


def seed_overrides(project_dir: Path, route: str) -> list[dict]:
    """One override per channel, on distinct nodes of `route`, chosen from the
    manifest's own `editable` lists rather than guessed.

    Deliberately spread across nodes: putting several channels on one node would
    test one id surviving, when what matters is that a whole page's worth of
    edits survives.
    """
    manifest = _manifest(project_dir)
    active = _active(manifest)
    sections = route_sections(project_dir, route)
    if not sections:
        raise StageError("edit:setup", f"route '{route}' has no active sections")

    def candidates(channel: str, *, depth: int) -> list[str]:
        return [
            node_id
            for node_id, node in active.items()
            if node_id.startswith(f"{route}.")
            and node_id.count(".") == depth
            and channel in node["editable"]
        ]

    used: set[str] = set()

    def take(channel: str, depth: int) -> str | None:
        for node_id in candidates(channel, depth=depth):
            if node_id not in used:
                used.add(node_id)
                return node_id
        return None

    entries: list[dict] = []
    style_target = take("style", 1) or take("style", 2)
    if style_target is not None:
        entries.append(
            {
                "nodeId": style_target,
                "channel": "style",
                "value": {"backgroundColor": "color.semantic.surface"},
            }
        )
    text_target = take("text", 2)
    if text_target is not None:
        entries.append(
            {"nodeId": text_target, "channel": "text", "value": "Edited before regeneration"}
        )
    layout_target = take("layout", 2)
    if layout_target is not None:
        entries.append({"nodeId": layout_target, "channel": "layout", "value": {"marginTop": "16px"}})
    visibility_target = take("visibility", 2)
    if visibility_target is not None:
        entries.append({"nodeId": visibility_target, "channel": "visibility", "value": True})
    if len(sections) > 1:
        # sectionOrder must name EVERY section on the route or the export fails
        # loudly by design (7.5) — so this swaps the first two rather than
        # writing a partial list.
        reordered = [sections[1], sections[0], *sections[2:]]
        entries.append({"nodeId": route, "channel": "sectionOrder", "value": reordered})

    if not entries:
        raise StageError("edit:setup", f"no editable nodes found on route '{route}'")

    route_path = active[sections[0]]["route"]
    (project_dir / "overrides").mkdir(exist_ok=True)
    (project_dir / "overrides" / f"{route}.overrides.json").write_text(
        json.dumps(
            {
                "version": 1,
                "route": route_path,
                "overrides": [{**entry, "updatedAt": STAMP} for entry in entries],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return entries


def check_overrides_survived(project_dir: Path, entries: list[dict], summary: dict, step: str) -> dict:
    """The invariant: no override was lost while its node survived.

    An override whose node the model removed is an ORPHAN, which is a correct
    outcome the editor surfaces (PRD 4.3) — so orphans are reported, not failed
    on. What is never acceptable is a node that still exists whose override the
    regeneration dropped, or an override the run silently stopped tracking.
    """
    active = _active(_manifest(project_dir))
    declared_orphans = set(summary.get("orphanedOverrides", []))
    lost: list[str] = []
    orphaned: list[str] = []
    for entry in entries:
        node_id = entry["nodeId"]
        if entry["channel"] == "sectionOrder":
            continue  # keyed by route slug, not a manifest node
        if node_id in active:
            if node_id in declared_orphans:
                lost.append(node_id)  # still there, yet reported as having no target
        elif node_id in declared_orphans:
            orphaned.append(node_id)
        else:
            # gone from the manifest AND never declared: the silent drop this
            # whole architecture exists to prevent
            lost.append(node_id)
    if lost:
        raise StageError(step, f"overrides lost without being declared orphaned: {sorted(lost)}")
    return {"orphaned": sorted(orphaned), "survived": sorted(set(active) & {e["nodeId"] for e in entries})}


def edit_loop(
    run_id: str,
    *,
    route: str | None = None,
    skip_page_regen: bool = False,
    skip_add_section: bool = False,
    add_archetype: str = "cta-band",
) -> dict:
    project_dir = GENERATED_DIR / run_id
    if not (project_dir / "manifest.json").exists():
        raise StageError("edit:setup", f"no generated project at {project_dir}")

    route = route or pick_route(project_dir)
    entries = seed_overrides(project_dir, route)
    sections = route_sections(project_dir, route)
    timings: dict[str, float] = {}
    steps: dict[str, dict] = {}

    # --- 1. one section (7.1's path) --------------------------------------
    target = next(
        (
            entry["nodeId"].rsplit(".", 1)[0]
            for entry in entries
            if entry["channel"] == "text" and entry["nodeId"].count(".") == 2
        ),
        sections[0],
    )
    started = time.monotonic()
    summary = regenerate_section(run_id, target, "Warm the tone slightly; keep the same structure.")
    timings["section_regen"] = round(time.monotonic() - started, 2)
    if not summary["passed"]:
        raise StageError("edit:section-regen", summary["failureReport"][:2000])
    steps["section_regen"] = {
        "section": target,
        **check_overrides_survived(project_dir, entries, summary, "edit:section-regen"),
    }

    # --- 2. a whole page (7.9) -------------------------------------------
    if not skip_page_regen:
        started = time.monotonic()
        summary = regenerate_page(run_id, route, "Tighten the copy; keep every section's structure.")
        timings["page_regen"] = round(time.monotonic() - started, 2)
        if not summary["passed"]:
            raise StageError("edit:page-regen", summary["failureReport"][:4000])
        steps["page_regen"] = {
            "sections": summary["sections"],
            **check_overrides_survived(project_dir, entries, summary, "edit:page-regen"),
        }

    # --- 3. add a section (7.6) ------------------------------------------
    if not skip_add_section:
        started = time.monotonic()
        added = add_section(
            run_id, route, add_archetype, "A closing call to action for this page."
        )
        timings["add_section"] = round(time.monotonic() - started, 2)
        if not added["passed"]:
            raise StageError("edit:add-section", added.get("failureReport", "")[:2000])
        new_id = added["sectionId"]
        if new_id not in _active(_manifest(project_dir)):
            raise StageError("edit:add-section", f"{new_id} is not an active manifest node")
        # The editor would write this; a headless run has to do it itself, and
        # the exporter REQUIRES it — an order that omits the new section is a
        # hard failure by design (7.5), which is exactly the coupling worth
        # exercising here.
        _extend_section_order(project_dir, route, new_id)
        steps["add_section"] = {"sectionId": new_id, "archetype": added["archetype"]}

    # --- 4. re-export: typecheck + all seven gates + production build ----
    export_dir = GENERATED_DIR / f"{run_id}-export-edited"
    started = time.monotonic()
    proc = _run_compiler_cli(["scripts/export.ts", str(project_dir), str(export_dir), "--clean"])
    timings["export"] = round(time.monotonic() - started, 2)
    if proc.returncode != 0:
        raise StageError("edit:export", (proc.stderr or proc.stdout)[-3000:])

    return {
        "run_id": run_id,
        "route": route,
        "seeded_channels": sorted({entry["channel"] for entry in entries}),
        "steps": steps,
        "timings_s": timings,
        "export_dir": str(export_dir),
    }


def _extend_section_order(project_dir: Path, route: str, new_id: str) -> None:
    path = project_dir / "overrides" / f"{route}.overrides.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    order_entry = next(
        (entry for entry in data["overrides"] if entry["channel"] == "sectionOrder"), None
    )
    if order_entry is None:
        data["overrides"].append(
            {
                "nodeId": route,
                "channel": "sectionOrder",
                "value": route_sections(project_dir, route),
                "updatedAt": STAMP,
            }
        )
    elif new_id not in order_entry["value"]:
        order_entry["value"].append(new_id)
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.acceptance_edit")
    parser.add_argument("--run-id", required=True, help="An already-generated project.")
    parser.add_argument("--route", help="Route to exercise (default: the one with most sections).")
    parser.add_argument("--skip-page-regen", action="store_true")
    parser.add_argument("--skip-add-section", action="store_true")
    parser.add_argument("--add-archetype", default="cta-band")
    args = parser.parse_args()

    try:
        result = edit_loop(
            args.run_id,
            route=args.route,
            skip_page_regen=args.skip_page_regen,
            skip_add_section=args.skip_add_section,
            add_archetype=args.add_archetype,
        )
    except StageError as e:
        print(json.dumps({"failed_stage": e.stage, "detail": e.detail}, indent=2, default=str))
        raise SystemExit(1) from e

    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
