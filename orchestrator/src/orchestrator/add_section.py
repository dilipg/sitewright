"""Add-a-section (PRD 4.1, build prompt 7.6): generate ONE new section into an
existing route.

PRD 4.1: '"+" between sections opens the archetype catalog (with previews) + an
instruction box. Runs as a regen-style single-section generation appended to the
site plan.'

"Regen-style" but NOT a regen: there is no recorded execution to fork, because
this section has never existed. So it is a first generation of a single section
into an already-built project -- exactly what page fan-out does per section --
reusing `generate_section_flow` with `reuse_workspace=True` so the project's own
generated tokens and primitives are the design context rather than the fixture's.

Three things this must get right, none of which the section flow does for us:

1. **The site plan is the record of what the site contains**, so a section that
   exists only in source would be invisible to every later stage that reads the
   plan (including a future re-plan). Appended there, at the end of the route's
   section list.
2. **The page's index.tsx is APPENDED to, never re-assembled.**
   `assemble_page_index_source` rebuilds a page from a section list that
   includes which sections FAILED -- information the manifest does not record,
   because a failed section never proposed a manifest entry. Re-assembling from
   the manifest would therefore silently drop the page's
   FailedSectionPlaceholder. Appending adds two imports and one render line and
   cannot lose anything.
3. **Position is not this module's business.** Node ids are semantic and never
   positional (contract 5.2), so a new section appends to the source and the
   EDITOR places it with a `sectionOrder` override (PRD 3.3, milestone 7.5).
   Nothing is renumbered and no existing id changes, which is why 7.6 wanted
   7.5 first.
"""

import argparse
import json
import re
from pathlib import Path

from orchestrator.catalog import ARCHETYPE_CATALOG
from orchestrator.section_pipeline import GENERATED_DIR, generate_section_flow


def slugify(text: str) -> str:
    """A section slug from free text: lowercase, hyphen-separated, no leading
    or trailing hyphens. Slugs are part of node ids, and contract 5.2 requires
    those to be semantic, so this keeps whatever meaning the words carry."""
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "section"


def unique_section_slug(manifest: dict, route: str, desired: str) -> str:
    """A slug not already taken on this route.

    Collisions are resolved with a numeric SUFFIX on an otherwise semantic slug
    (`pricing-tiers-2`), never by renumbering the existing one: ids are
    immutable once registered (contract 5.2), so the new arrival is what has to
    give way.
    """
    taken = {
        node_id.split(".", 1)[1]
        for node_id in manifest["nodes"]
        if node_id.startswith(f"{route}.") and node_id.count(".") == 1
    }
    if desired not in taken:
        return desired
    suffix = 2
    while f"{desired}-{suffix}" in taken:
        suffix += 1
    return f"{desired}-{suffix}"


def append_to_index(source: str, *, route_slug: str, section_slug: str, component: str) -> str:
    """Adds one section to a page's existing index.tsx.

    Deliberately textual and minimal, matching the shape
    `assemble_page_index_source` emits, so the file stays byte-comparable with
    a freshly assembled page. See this module's docstring for why this appends
    rather than re-assembling.
    """
    data_var = component[0].lower() + component[1:] + "Data"
    new_imports = (
        f'import {{ {data_var} }} from "./mock/{component}.data";\n'
        f'import {component} from "./sections/{component}";'
    )
    render = f'      <{component} nodeId="{route_slug}.{section_slug}" {{...{data_var}}} />'

    if f'nodeId="{route_slug}.{section_slug}"' in source:
        raise SystemExit(f"{route_slug}.{section_slug} is already rendered in index.tsx")

    import_lines = [line for line in source.split("\n") if line.startswith("import ")]
    if not import_lines:
        raise SystemExit("cannot add a section: the page's index.tsx has no imports to append to")
    source = source.replace(import_lines[-1], f"{import_lines[-1]}\n{new_imports}", 1)

    closing = "\n    </>"
    if closing not in source:
        raise SystemExit(
            "cannot add a section: the page renders a single element, not a list of sections"
        )
    return source.replace(closing, f"\n{render}{closing}", 1)


def append_to_siteplan(project_dir: Path, route: str, section: dict) -> None:
    """Records the new section in `plan/siteplan.json` -- the plan is the record
    of what the site contains, and a section present only in source would be
    invisible to anything that reads the plan later."""
    plan_path = project_dir / "plan" / "siteplan.json"
    if not plan_path.exists():
        # Older runs (and the fixture) predate plan files; the section is still
        # fully registered in the manifest and rendered, so this is a missing
        # record rather than a failure.
        return
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    for entry in plan.get("routes", []):
        if entry.get("slug") == route:
            entry.setdefault("sections", []).append(section)
            plan_path.write_text(json.dumps(plan, indent=2) + "\n", encoding="utf-8")
            return
    raise SystemExit(f"route '{route}' is not in the site plan")


def add_section(run_id: str, route: str, archetype: str, instruction: str) -> dict:
    """Generates a new section on `route` and wires it into the page.

    Returns the outcome in the same shape the regen endpoints use, plus the new
    section's id -- the editor needs it to position the section and to select it.
    """
    if archetype not in ARCHETYPE_CATALOG:
        raise SystemExit(
            f"unknown archetype '{archetype}'; the catalog has: {', '.join(sorted(ARCHETYPE_CATALOG))}"
        )

    project_dir = GENERATED_DIR / run_id
    manifest = json.loads((project_dir / "manifest.json").read_text(encoding="utf-8"))
    route_node = next(
        (node for node_id, node in manifest["nodes"].items() if node_id.startswith(f"{route}.")),
        None,
    )
    if route_node is None:
        raise SystemExit(f"route '{route}' has no registered nodes in run '{run_id}'")

    section_slug = unique_section_slug(manifest, route, slugify(archetype))
    section_id = f"{route}.{section_slug}"
    print(f"adding {section_id} ({archetype})", flush=True)

    index_path = project_dir / "src" / "pages" / route / "index.tsx"
    index_before = index_path.read_text(encoding="utf-8")

    # assemble_index=False: this flow's own single-section assembly would
    # OVERWRITE index.tsx with a one-section page, deleting every section
    # already on the route. The append below is the assembly step.
    result = generate_section_flow(
        run_id=run_id,
        page_brief=f"The {route} page of an existing site.",
        section_brief=instruction,
        reuse_workspace=True,
        route_slug=route,
        route_path=route_node["route"],
        section_slug=section_slug,
        archetype=archetype,
        assemble_index=False,
    )

    if not result.get("passed", False):
        # The section flow already rolled its manifest proposals back on
        # failure; index.tsx was never touched, so there is nothing to undo.
        return {
            "passed": False,
            "sectionId": section_id,
            "failureReport": result.get("failure_report", "section generation failed"),
        }

    component = manifest_component(project_dir, section_id)
    index_path.write_text(
        append_to_index(
            index_before, route_slug=route, section_slug=section_slug, component=component
        ),
        encoding="utf-8",
    )
    append_to_siteplan(
        project_dir, route, {"slug": section_slug, "archetype": archetype, "brief": instruction}
    )
    return {"passed": True, "sectionId": section_id, "archetype": archetype, "failureReport": ""}


def manifest_component(project_dir: Path, section_id: str) -> str:
    """The component name the section actually registered, read back from the
    manifest rather than derived from the slug -- the manifest is the registry
    (contract section 2), and the agent chose the component name."""
    manifest = json.loads((project_dir / "manifest.json").read_text(encoding="utf-8"))
    node = manifest["nodes"].get(section_id)
    if node is None:
        raise SystemExit(f"{section_id} passed gates but is not in the manifest")
    return node["component"]


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.add_section")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--route", required=True)
    parser.add_argument("--archetype", required=True)
    parser.add_argument("--instruction", required=True)
    args = parser.parse_args()

    summary = add_section(args.run_id, args.route, args.archetype, args.instruction)
    print(json.dumps(summary, indent=2))
    # machine-readable single line for the preview server's endpoint
    print(f"ADD_SECTION_RESULT {json.dumps(summary)}")


if __name__ == "__main__":
    main()
