"""Single-section generation (build prompt 3.3, pipeline 2.5/5.4):

  render hero prompt → structured model call → write files into
  generated/<run>/ → manifest propose/commit (compiler CLI) → gates
  (compiler CLI) → on failure, bounded retry (max 2) with the gate
  failure report appended to the prompt → manifest committed only for
  the attempt that validates; a failed attempt's commit is rolled back.

Checkpoints map to pipeline 5.2: generate_section = section.generated,
run_gates_step = section.validated (each also writes the run-log event).
Every checkpointed step takes `attempt` in its args so Kitaru's
input-hash caching can never play back a stale result across retries.
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import kitaru
from kitaru import checkpoint, flow

from orchestrator.config import ORCHESTRATOR_ROOT
from orchestrator.design_context import build_design_context
from orchestrator.fixture_context import (
    FIXTURE_DIR,
    fixture_primitive_signatures,
    fixture_route_table,
    fixture_tokens,
)
from orchestrator.model_call import call_model_structured_impl
from orchestrator.placeholder_shield import shield, unshield
from orchestrator.prompts import load_template, render_template
from orchestrator.runlog import append_run_event, default_run_log_path

REPO_ROOT = ORCHESTRATOR_ROOT.parent
COMPILER_DIR = REPO_ROOT / "compiler"
GENERATED_DIR = REPO_ROOT / "generated"

# A section's structured output is the component, its mock data, one manifest
# proposal per node, AND its sectionMeta -- and the proposals come LAST, so a
# truncated response loses exactly the parts validation requires. The default
# 8192 was enough for a marketing section and is not enough for a dense app one:
# a data-grid emitted a 7.5 KB component, spent the whole budget on files, and
# came back with `manifestProposals` and `sectionMeta` missing. That is
# unrecoverable by retry -- three attempts failed identically, never reaching a
# gate, and the page shipped a FailedSectionPlaceholder while the run reported
# success. Output tokens are billed as emitted, so headroom costs nothing on the
# small sections that never approach it.
SECTION_MAX_TOKENS = 16000

MAX_ATTEMPTS = 3  # 1 generation + max 2 bounded retries (pipeline 5.4)

SECTION_TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "files": {
            "type": "object",
            "description": "repo-relative path -> complete file content",
            "additionalProperties": {"type": "string"},
        },
        "manifestProposals": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "nodeId": {"type": "string"},
                    "route": {"type": "string"},
                    "file": {"type": "string"},
                    "component": {"type": "string"},
                    "element": {"type": "string"},
                    "editable": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["nodeId", "route", "file", "component", "element", "editable"],
            },
        },
        "sectionMeta": {
            "type": "object",
            "properties": {
                "slug": {"type": "string"},
                "component": {"type": "string"},
                "summary": {"type": "string"},
            },
            "required": ["slug", "component", "summary"],
        },
        "orphanedOverrides": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["files", "manifestProposals", "sectionMeta"],
}


def materialize(value):
    """Checkpoint outputs may arrive as lazy artifact handles (on replay);
    flow-body control flow must materialize before inspecting them."""
    if hasattr(value, "load") and callable(value.load):
        return value.load()
    return value


# ---------- pure helpers (unit-tested) ----------


DEFAULT_ROUTES = [{"slug": "home", "path": "/"}]


def page_component_name(route_slug: str) -> str:
    """A route slug as a valid React component identifier.

    `"public-form".capitalize()` is `"Public-form"`, which produces
    `export default function Public-formPage()` -- a syntax error, not a naming
    wart. It went unnoticed until an acceptance run first planned a two-word
    route: every route in every earlier run (home, shop, product, about,
    support) happened to be a single word. Route slugs are kebab-case by
    contract, so this is the general case, not an edge one.
    """
    return "".join(part.capitalize() for part in route_slug.split("-") if part)


def _humanize_slug(slug: str) -> str:
    return " ".join(word.capitalize() for word in slug.split("-"))


def _provisional_routes_ts(routes: list[dict]) -> str:
    """A minimal routes.ts for the pre-Shell-Agent workspace state — the real
    ground truth (with real titles) is written deterministically from the
    approved site plan by shell_pipeline.build_routes_ts once the Shell
    Agent runs; call sites that never reach that stage (M3/M4/soak/stress,
    single-section testing) keep this provisional version."""
    entries = ",\n".join(
        f'  {{ slug: "{r["slug"]}", path: "{r["path"]}", title: "{r.get("title") or _humanize_slug(r["slug"])}" }}'
        for r in routes
    )
    return (
        "/** Ground-truth route table (contract section 2). Every internal href must exist here. */\n"
        "export interface RouteDef {\n"
        "  slug: string;\n"
        "  path: string;\n"
        "  title: string;\n"
        "}\n\n"
        f"export const routes: RouteDef[] = [\n{entries},\n];\n"
    )


def prepare_workspace_dir(project_dir: str, routes: list[dict] | None = None) -> str:
    """Fixture copy with blank pages: tokens/primitives/shell stay
    hand-written (M3 stub table); manifest is emptied. Full replace —
    idempotent under replay. The plan/ directory (brief, siteplan, approval)
    is part of the project's atomic state and survives the reset.

    `routes` (each {"slug", "path"}) scaffolds an empty pages/<slug>/ +
    overrides/<slug>.overrides.json for every planned route (build prompt
    5.3 fan-out). The fixture may ship more pages than a given caller's
    route list (it's a multi-route hand fixture, reused as the compiler
    test bed) — every page directory is wiped and only the requested routes
    are recreated, and routes.ts is rewritten to match exactly, so a
    single-route caller never inherits a stray fixture page or a nav link
    to a route that doesn't exist in its own workspace. Defaults to just
    home for every M3/M4/soak/stress call site that predates multi-route."""
    target = Path(project_dir)
    resolved_routes = routes if routes is not None else DEFAULT_ROUTES
    preserved_plan: dict[str, str] = {}
    plan_dir = target / "plan"
    if plan_dir.exists():
        preserved_plan = {
            entry.name: entry.read_text(encoding="utf-8")
            for entry in plan_dir.iterdir()
            if entry.is_file()
        }
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(
        FIXTURE_DIR,
        target,
        ignore=shutil.ignore_patterns("node_modules", "dist", "sections", "mock"),
    )
    # the fixture may ship pages beyond what this caller asked for (or none
    # of what it asked for) — replace wholesale rather than special-casing
    # whichever page(s) the fixture happens to include today
    pages_dir = target / "src" / "pages"
    if pages_dir.exists():
        shutil.rmtree(pages_dir)
    for route in resolved_routes:
        (pages_dir / route["slug"]).mkdir(parents=True, exist_ok=True)
    (target / "src" / "shell" / "routes.ts").write_text(
        _provisional_routes_ts(resolved_routes), encoding="utf-8", newline="\n"
    )

    (target / "manifest.json").write_text(
        json.dumps({"version": 1, "nodes": {}}, indent=2) + "\n", encoding="utf-8"
    )
    for route in resolved_routes:
        (target / "overrides" / f"{route['slug']}.overrides.json").write_text(
            json.dumps({"version": 1, "route": route["path"], "overrides": []}, indent=2) + "\n",
            encoding="utf-8",
        )
    if preserved_plan:
        plan_dir = target / "plan"
        plan_dir.mkdir(parents=True, exist_ok=True)
        for name, content in preserved_plan.items():
            (plan_dir / name).write_text(content, encoding="utf-8")
    return str(target)


def build_index_source(*, route_slug: str, section_slug: str, component: str) -> str:
    """Deterministic page assembly for the single-section skeleton (the
    page agent's own assembly step arrives with fan-out in M5)."""
    data_var = component[0].lower() + component[1:] + "Data"
    return (
        f'import {{ {data_var} }} from "./mock/{component}.data";\n'
        f'import {component} from "./sections/{component}";\n'
        "\n"
        "/** Page assembly only, no styling decisions (contract section 2). */\n"
        f"export default function {page_component_name(route_slug)}Page() {{\n"
        f'  return <{component} nodeId="{route_slug}.{section_slug}" {{...{data_var}}} />;\n'
        "}\n"
    )


def ensure_route_page_dirs(project_dir: str, routes: list[dict]) -> None:
    """Idempotent, non-destructive scaffolding for routes BEYOND the ones
    the initial prepare_workspace already created (which only ever creates
    "home" — the fixture's one route). Fan-out (build prompt 5.3) calls this
    after the Design System/Shell agents have already written tokens,
    primitives, and shell into this same workspace — a full reset here
    would destroy their output, so this only ever creates what's missing."""
    target = Path(project_dir)
    for route in routes:
        (target / "src" / "pages" / route["slug"]).mkdir(parents=True, exist_ok=True)
        overrides_path = target / "overrides" / f"{route['slug']}.overrides.json"
        if not overrides_path.exists():
            overrides_path.write_text(
                json.dumps({"version": 1, "route": route["path"], "overrides": []}, indent=2) + "\n",
                encoding="utf-8",
            )


def write_section_files(
    project_dir: str, *, route_slug: str, component: str, files: dict[str, str]
) -> list[str]:
    """Writes one section's files, replacing ONLY that section's own prior
    attempt (by component name) — never a sibling section's files (contract
    5.3: a section rewrite fully replaces its own files, never appends, and
    multiple sections coexist per page once fan-out is in play)."""
    page = Path(project_dir) / "src" / "pages" / route_slug
    for stale in (page / "sections" / f"{component}.tsx", page / "mock" / f"{component}.data.ts"):
        stale.unlink(missing_ok=True)

    written = []
    for rel_path, content in files.items():
        target = Path(project_dir) / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
        written.append(rel_path)
    return sorted(written)


# How a page arranges its sections. A marketing page stacks them down the
# screen, which a bare fragment already does. An APP SCREEN does not: its chrome
# sits on top and its panes sit SIDE BY SIDE, and the pane sections say so in
# their own classNames (`w-[18rem] shrink-0`, `flex-1`) -- which mean nothing
# unless something puts them in a row.
#
# `flex-wrap` rather than a nested row, deliberately: it arranges the panes while
# keeping every section a DIRECT SIBLING of every other. Nesting the panes one
# level deeper would arrange them just as well and would break BOTH reorder
# implementations, which each operate on the section elements' common parent --
# the exporter rewrites that parent's children, the shim moves real DOM nodes
# within it. A full-width chrome section takes a whole flex line to itself, so
# the panes fall onto the next line together with no extra markup.
PAGE_LAYOUTS: dict[str, str] = {
    "app-screen": "flex min-h-screen flex-wrap items-stretch content-start",
}


def assemble_page_index_source(
    *, route_slug: str, sections: list[dict], page_archetype: str = ""
) -> str:
    """Deterministic multi-section page assembly (pipeline 2.5's per-page
    assembly step). Each section dict is either {"slug","component"} (a
    generated section, imported normally) or {"slug","failed": True} (bounded
    retries exhausted — pipeline 5.4: rendered as a labeled placeholder
    instead of blocking the rest of the page)."""
    imports = []
    renders = []
    needs_placeholder = False
    for section in sections:
        node_id = f"{route_slug}.{section['slug']}"
        if section.get("failed"):
            needs_placeholder = True
            # No agent ever proposed a manifest entry for this node (there
            # was no successful structured output to propose one from), so
            # it must not carry a data-node-id either -- same "deterministic,
            # non-agent-authored content stays outside manifest jurisdiction"
            # precedent as the design-system gallery page. A stray nodeId
            # here fails gate 4 (node-ids-registered) at fanout's
            # whole-project check.
            renders.append("      <FailedSectionPlaceholder />")
            continue
        component = section["component"]
        data_var = component[0].lower() + component[1:] + "Data"
        imports.append(f'import {{ {data_var} }} from "./mock/{component}.data";')
        imports.append(f'import {component} from "./sections/{component}";')
        renders.append(f'      <{component} nodeId="{node_id}" {{...{data_var}}} />')

    if needs_placeholder:
        imports.insert(0, 'import FailedSectionPlaceholder from "../../lib/FailedSectionPlaceholder";')

    imports_source = "\n".join(imports)
    layout = PAGE_LAYOUTS.get(page_archetype)
    if layout is None:
        body = "    <>\n" + "\n".join(renders) + "\n    </>"
    else:
        # one extra indent level for the wrapped children
        body = (
            f'    <div className="{layout}">\n'
            + "\n".join(f"  {line}" for line in renders)
            + "\n    </div>"
        )
    return (
        f"{imports_source}\n\n"
        "/** Page assembly only, no styling decisions (contract section 2). */\n"
        f"export default function {page_component_name(route_slug)}Page() {{\n"
        "  return (\n"
        f"{body}\n"
        "  );\n"
        "}\n"
    )


def files_of(model_result: dict) -> dict[str, str]:
    """Defensive accessor, same rationale as proposals_of: under retry
    pressure a live run returned "files" as a JSON-encoded STRING (double-
    encoded) instead of the native object the tool schema declares — Claude's
    tool-use does not hard-enforce declared types. Parses that form back into
    a dict; an unparseable or non-dict result becomes {} (no files written),
    which the following commit+gates cycle then fails cleanly, driving a
    retry — never an unhandled AttributeError on `.items()`."""
    files = model_result["data"].get("files", {})
    if isinstance(files, str):
        try:
            files = json.loads(files)
        except json.JSONDecodeError:
            return {}
    return files if isinstance(files, dict) else {}


def proposals_of(model_result: dict) -> list[dict]:
    """Defensive accessor: the tool schema declares manifestProposals
    required, but Claude's tool-use does not hard-enforce required fields —
    the model can still omit it (observed live, under retry pressure with a
    large failure-report appended). An absent key must become an empty list
    a downstream check can fail cleanly on, never an unhandled KeyError that
    crashes the whole page worker mid-fan-out."""
    return model_result["data"].get("manifestProposals", [])


def validate_root_proposal(section_id: str, manifest_proposals: list[dict]) -> str:
    """Every section must propose a manifest entry for its own root node id
    (contract 5.2: "child elements carry literal ids"; the root is what the
    nodeId prop supplies). Without a root proposal the root id never becomes
    an active manifest node — gate 4 can't catch this during the section's
    own pre-assembly check (skipMissingCheck exempts root ids precisely
    because they aren't literally attached yet), so it only surfaces as
    "unregistered-node-id" at page-assembly time, with no retry budget left.
    Returns a failure-report line, or "" when the root proposal is present."""
    if any(proposal["nodeId"] == section_id for proposal in manifest_proposals):
        return ""
    return (
        f'- content: manifestProposals is missing an entry for this section\'s own '
        f'root node id "{section_id}". Every section must register its own root '
        "element, not just its children (contract 5.2/5.4)."
    )


def validate_section_meta(model_result: dict) -> str:
    """Defensive check, same principle as proposals_of() above: the tool
    schema declares sectionMeta (with slug and component) required, but
    Claude's tool-use does not hard-enforce required fields — the model can
    omit sectionMeta entirely, or leave slug/component empty within it
    (observed live: write_section_only's bare data["sectionMeta"] raised an
    unhandled KeyError that crashed the whole page worker process, silently
    dropping every remaining section queued behind it on that route — no
    retry, no FailedSectionPlaceholder, since the crash happened outside the
    retry loop's own try/except-free body). Returns a failure-report line,
    or "" when sectionMeta is present and complete."""
    meta = model_result["data"].get("sectionMeta")
    if not isinstance(meta, dict) or not meta.get("slug") or not meta.get("component"):
        return (
            '- content: sectionMeta is missing or incomplete (must include non-empty '
            '"slug" and "component" fields). This section cannot be written or '
            "assembled without it."
        )
    return ""


def format_gate_failures(report: dict) -> str:
    lines = []
    for gate in report.get("gates", []):
        for failure in gate.get("failures", []):
            lines.append(f"- gate {gate['gate']} ({gate['name']}): {failure['message']}")
    return "\n".join(lines)


FIRST_GENERATION_REGEN_BLOCK = "(first generation — no regeneration context)"


def build_regen_block(
    project_dir: str | Path, section_prefix: str, instruction: str
) -> tuple[str, list[str]]:
    """REGEN BLOCK per pipeline 4.1 anatomy: user instruction, previously
    overridden node IDs (with channels), the section's active manifest
    entries, and the current section source. Returns (block, overridden_ids)."""
    project = Path(project_dir)

    def in_section(node_id: str) -> bool:
        return node_id == section_prefix or node_id.startswith(f"{section_prefix}.")

    manifest = json.loads((project / "manifest.json").read_text(encoding="utf-8"))
    section_entries = {
        node_id: node
        for node_id, node in manifest["nodes"].items()
        if in_section(node_id) and node["status"] == "active"
    }

    route_slug = section_prefix.split(".")[0]
    overrides_path = project / "overrides" / f"{route_slug}.overrides.json"
    override_entries = (
        json.loads(overrides_path.read_text(encoding="utf-8"))["overrides"]
        if overrides_path.exists()
        else []
    )
    channels_by_id: dict[str, set[str]] = {}
    for entry in override_entries:
        if in_section(entry["nodeId"]):
            channels_by_id.setdefault(entry["nodeId"], set()).add(entry["channel"])
    overridden_ids = sorted(channels_by_id)

    overridden_lines = (
        "\n".join(
            f"- {node_id} (channels: {', '.join(sorted(channels))})"
            for node_id, channels in sorted(channels_by_id.items())
        )
        or "(none)"
    )

    source_files = sorted({node["file"] for node in section_entries.values()})
    components = sorted({node["component"] for node in section_entries.values()})
    for component in components:
        mock_path = f"src/pages/{route_slug}/mock/{component}.data.ts"
        if (project / mock_path).exists() and mock_path not in source_files:
            source_files.append(mock_path)
    source_blocks = "\n".join(
        f"--- {file_path} ---\n{(project / file_path).read_text(encoding='utf-8')}"
        for file_path in source_files
        if (project / file_path).exists()
    )

    block = (
        "REGENERATION REQUEST — this section already exists; regenerate it per the "
        "user's instruction while preserving continuity.\n"
        f"User instruction: {instruction}\n\n"
        "Previously overridden node IDs — the user has edits attached to each of "
        "these. Preserve every ID whose element still exists conceptually in your "
        "new output. If your new output legitimately removes one, declare it in "
        "orphanedOverrides. Never silently drop or falsely declare one (machine-checked, gate 7):\n"
        f"{overridden_lines}\n\n"
        "Current manifest entries for this section:\n"
        f"{json.dumps(section_entries, indent=2)}\n\n"
        "Current section source (your files fully replace these):\n"
        f"{source_blocks}"
    )
    return block, overridden_ids


def user_prompt_with_failures(base_user: str, failure_report: str) -> str:
    if not failure_report:
        return base_user
    return (
        f"{base_user}\n\n"
        "[RETRY]\n"
        "PREVIOUS ATTEMPT FAILED VALIDATION. Fix every issue below and emit the "
        "corrected section. Do not repeat these mistakes:\n"
        f"{failure_report}"
    )


def _run_compiler_cli(script_args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", *script_args],
        cwd=COMPILER_DIR,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=300,
    )


# ---------- checkpointed steps ----------


@checkpoint
def prepare_workspace(run_id: str, workspace_token: str = "") -> str:
    """workspace_token distinguishes checkpoint inputs when the caller needs
    a REAL reset: a cache-hit plays back the recorded path without re-running
    the reset side effect (learned in the 4.3 stress runner's rebase)."""
    return prepare_workspace_dir(str(GENERATED_DIR / run_id))


@checkpoint
def generate_section(
    *,
    run_id: str,
    attempt: int,
    system: str,
    user: str,
    template_name: str,
    template_version: str,
    template_hash: str,
    prompt_hash: str,
    section: str = "home.hero",
) -> dict:
    # The prompts arrive shielded so Kitaru's replay-time env-var substitution
    # cannot choke on the `${nodeId}` the contract requires in list-item ids
    # (see placeholder_shield). Everything downstream -- the model call and the
    # run log -- sees the real text.
    system = unshield(system)
    user = unshield(user)
    result = call_model_structured_impl(
        role="page",
        system=system,
        user=user,
        tool_name="emit_section",
        tool_description="Emit the generated section: files, manifest proposals, section metadata.",
        tool_schema=SECTION_TOOL_SCHEMA,
        max_tokens=SECTION_MAX_TOKENS,
    )
    append_run_event(
        default_run_log_path(run_id),
        run_id=run_id,
        event_type="section.generated",
        section=section,
        attempt=attempt,
        template_name=template_name,
        template_version=template_version,
        template_hash=template_hash,
        prompt_hash=prompt_hash,
        system_prompt=system,
        user_prompt=user,
        model=result["model"],
        params={"tool": "emit_section"},
        usage=result["usage"],
        duration_s=result.get("duration_s"),
        raw_output=json.dumps(result["data"], indent=2),
        checkpoint_ref=f"{kitaru.current_execution_id()}/generate_section#a{attempt}",
    )
    return result


@checkpoint
def write_section_output(project_dir: str, model_result: dict, attempt: int, route_slug: str = "home") -> dict:
    """Single-section skeleton path (M3/M4/soak/stress): wipes the whole
    page (only ever one section) and writes its own index.tsx. Fan-out pages
    with multiple sections use write_section_only + a separate assembly step
    instead (a sibling section's files must survive this section's retries)."""
    data = model_result["data"]
    page = Path(project_dir) / "src" / "pages" / route_slug
    for sub in ("sections", "mock"):
        if (page / sub).exists():
            shutil.rmtree(page / sub)

    written = []
    for rel_path, content in files_of(model_result).items():
        target = Path(project_dir) / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
        written.append(rel_path)

    meta = data["sectionMeta"]
    index_source = build_index_source(
        route_slug=route_slug, section_slug=meta["slug"], component=meta["component"]
    )
    (page / "index.tsx").write_text(index_source, encoding="utf-8", newline="\n")
    return {"written": sorted(written), "sectionMeta": meta}


@checkpoint
def write_section_only(project_dir: str, model_result: dict, attempt: int, route_slug: str = "home") -> dict:
    """Fan-out path: writes just this section's own files (contract 5.3),
    leaving siblings and page assembly (a separate later step) untouched."""
    data = model_result["data"]
    meta = data["sectionMeta"]
    written = write_section_files(
        project_dir, route_slug=route_slug, component=meta["component"], files=files_of(model_result)
    )
    return {"written": written, "sectionMeta": meta}


@checkpoint
def commit_section_manifest(
    project_dir: str,
    model_result: dict,
    attempt: int,
    regen_section: str = "",
    owner: str = "page:home",
) -> dict:
    """Validates + commits proposals through the manifest service CLI —
    manifest.json changes only through the service (contract 5.4), lock-
    serialized against concurrent page workers (build prompt 5.3 fan-out).
    On regeneration this is a replace-section commit: surviving IDs update,
    removed IDs tombstone. The pre-commit snapshot for rollback comes from
    the CLI's own atomic read (inside its lock) — a Python-side pre-read
    here would go stale the instant a concurrent worker commits in between,
    and rolling back to a stale snapshot would erase that worker's commit.
    """
    # unique per (project, attempt, owner): concurrent page workers must
    # never share a proposals file
    proposals_file = Path(project_dir) / f".proposals-{owner.replace(':', '-')}-{attempt}.json"
    proposals_file.write_text(
        json.dumps(proposals_of(model_result)), encoding="utf-8"
    )
    command = (
        ["scripts/manifest.ts", "replace-section", project_dir, "--proposals", str(proposals_file), "--owner", owner, "--section", regen_section]
        if regen_section
        else ["scripts/manifest.ts", "commit", project_dir, "--proposals", str(proposals_file), "--owner", owner]
    )
    result = _run_compiler_cli(command)
    proposals_file.unlink(missing_ok=True)
    try:
        payload = json.loads(result.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        raise RuntimeError(f"manifest CLI produced no result: {result.stderr}") from None
    return {
        "ok": payload["ok"],
        "issues": payload["issues"],
        "tombstoned": payload.get("tombstoned", []),
        "previous_manifest": payload["previousManifest"],
    }


@checkpoint
def run_gates_step(
    project_dir: str,
    run_id: str,
    attempt: int,
    model_result: dict | None = None,
    overridden_ids: list[str] | None = None,
    section: str = "home.hero",
    scope_route: str | None = None,
    skip_missing_check: bool = False,
) -> dict:
    """Gates 1-6, plus gate 7 on regeneration runs (overridden_ids present):
    every previously-overridden ID must be attached in the output or declared
    in the agent's orphanedOverrides.

    scope_route (fan-out, build prompt 5.3): restricts gate 4 to this route
    so a section's own check can't fail on a SIBLING page worker's transient
    mid-commit state elsewhere in the same concurrently-mutating project.

    skip_missing_check: a section's own root node id is only literally
    attached once the PAGE is assembled (index.tsx's `<Hero nodeId="home.hero" />`);
    inside the section file itself the root carries `data-node-id={nodeId}`,
    a JSX expression by contract design, never a literal. In fan-out, a
    section's own gate check runs before assembly, so without this flag the
    root would always look "missing" regardless of scoping. Child ids stay
    fully checked. assemble_page's own (post-assembly) gate check never
    passes this.
    """
    # --typecheck completes gate 1 ("imports resolve; build passes", contract
    # section 8): without it a section can reference a field it never declared,
    # pass every gate, and only abort the EXPORT -- after the whole run's
    # spend, with no chance for a bounded retry to fix it. Safe under parallel
    # fan-out because the gates CLI filters tsc diagnostics to scope_route's
    # own directory, so a sibling worker's half-written page is not this
    # section's failure (see gates.ts gateTypechecks).
    args = ["scripts/gates.ts", project_dir, "--json", "--typecheck"]
    if scope_route is not None:
        args += ["--scope-route", scope_route]
    if skip_missing_check:
        args += ["--skip-missing-check"]
    declared_orphans: list[str] = []
    regen_file = Path(project_dir) / ".regen-context.json"
    if overridden_ids:
        declared_orphans = list((model_result or {}).get("data", {}).get("orphanedOverrides") or [])
        regen_file.write_text(
            json.dumps({"overriddenNodeIds": overridden_ids, "declaredOrphans": declared_orphans}),
            encoding="utf-8",
        )
        args += ["--regen", str(regen_file)]

    result = _run_compiler_cli(args)
    regen_file.unlink(missing_ok=True)
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(
            f"gates CLI produced no JSON report (exit {result.returncode}): {result.stderr or result.stdout}"
        ) from None
    report["declaredOrphans"] = declared_orphans
    append_run_event(
        default_run_log_path(run_id),
        run_id=run_id,
        event_type="section.validated",
        section=section,
        attempt=attempt,
        gate_results={
            "passed": report["passed"],
            "failures": [f for gate in report["gates"] for f in gate["failures"]],
        },
        declared_orphans=declared_orphans,
        checkpoint_ref=f"{kitaru.current_execution_id()}/run_gates_step#a{attempt}",
    )
    return report


@checkpoint
def rollback_manifest(
    project_dir: str,
    previous_manifest: str,
    attempt: int,
    proposals: list[dict] | None = None,
    owner: str = "page:home",
) -> bool:
    """Undoes a failed attempt's commit: proposals only stay committed at
    section.validated (contract 5.3).

    First-generation commits (proposals given, the fan-out path) undo via
    the manifest CLI's rollback-commit — lock-protected deletion of exactly
    this attempt's own node IDs, so a concurrent sibling page worker's
    commit landing in between is never erased. Regeneration commits (no
    proposals — replace-section can update an EXISTING node in place, so
    "just delete the new IDs" would lose the original entry) fall back to
    restoring the pre-attempt snapshot directly; regen is always a single
    interactive session, never concurrent, so this stays safe."""
    if proposals is not None:
        proposals_file = Path(project_dir) / f".rollback-{owner.replace(':', '-')}-{attempt}.json"
        proposals_file.write_text(json.dumps(proposals), encoding="utf-8")
        _run_compiler_cli(
            ["scripts/manifest.ts", "rollback-commit", project_dir, "--proposals", str(proposals_file), "--owner", owner]
        )
        proposals_file.unlink(missing_ok=True)
    else:
        (Path(project_dir) / "manifest.json").write_text(previous_manifest, encoding="utf-8")
    return True


# ---------- the flow ----------


@flow
def generate_section_flow(
    run_id: str,
    page_brief: str,
    section_brief: str,
    regen_block: str = FIRST_GENERATION_REGEN_BLOCK,
    regen_overridden_ids: list[str] | None = None,
    workspace_token: str = "",
    reuse_workspace: bool = False,
    route_slug: str = "home",
    route_path: str = "/",
    section_slug: str = "hero",
    archetype: str = "hero",
    prior_sections_text: str = "(none — this is the first section on the page)",
    route_table_text: str = "",
    assemble_index: bool = True,
    crash_after_model_call: bool = False,
) -> dict:
    """First generation by default; a regeneration is this same flow forked
    via Kitaru replay-with-overrides at the generate_section checkpoint with
    regen_block/regen_overridden_ids overridden (pipeline 5.5). Retries
    inside a regen keep both the regen context and the failure report.

    Reused per-section by page fan-out (build prompt 5.3, pipeline 2.5): a
    route's N sections are N separate executions of THIS flow (route_slug/
    section_slug/archetype/assemble_index=False), each independently
    checkpointed and resumable — the page-level "worker" is the orchestrating
    caller looping over them, not a single monolithic flow. assemble_index
    controls whether this call also writes the page's index.tsx (the M3
    single-section skeleton's own behavior) or leaves assembly to a later,
    separate step once every section on the page has completed.
    """
    print(f"exec_id: {kitaru.current_execution_id()}", flush=True)
    is_regen = regen_block != FIRST_GENERATION_REGEN_BLOCK
    owner = f"page:{route_slug}"
    section_id = f"{route_slug}.{section_slug}"
    # reuse_workspace: an earlier stage (Design System/Shell Agent, or an
    # already-prepared multi-route workspace) built this project — do not
    # reset it back to the fixture (build prompt 5.2 re-pointing)
    project_dir = (
        str(GENERATED_DIR / run_id)
        if reuse_workspace
        else materialize(prepare_workspace(run_id, workspace_token))
    )

    inventory_path = Path(project_dir) / "design-inventory.json"
    if reuse_workspace and inventory_path.exists():
        # generated tokens/primitives replace the fixture stub in context
        context_tokens = json.loads(
            (Path(project_dir) / "src" / "tokens" / "tokens.json").read_text(encoding="utf-8")
        )
        context_signatures = json.loads(inventory_path.read_text(encoding="utf-8"))["primitives"]
    else:
        context_tokens = fixture_tokens()
        context_signatures = fixture_primitive_signatures()

    from orchestrator.catalog import ARCHETYPE_CATALOG
    from orchestrator.page_pipeline import select_template

    template = select_template(archetype)
    context = {
        "design_context": build_design_context(context_tokens, context_signatures),
        "route_slug": route_slug,
        "route_path": route_path,
        "page_brief": page_brief,
        "prior_sections": prior_sections_text,
        "route_table": route_table_text or fixture_route_table(),
        "section_slug": section_slug,
        "section_brief": section_brief,
        "regen_block": regen_block,
    }
    if template.archetype == "generic-section":
        context["archetype_name"] = archetype
        context["archetype_description"] = ARCHETYPE_CATALOG.get(archetype, "a page section")
    rendered = render_template(template, context)

    failure_report = ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        user = user_prompt_with_failures(rendered.user, failure_report)
        generated = generate_section(
            run_id=run_id,
            attempt=attempt,
            system=shield(rendered.system),
            user=shield(user),
            template_name=rendered.template_name,
            template_version=rendered.template_version,
            template_hash=rendered.template_hash,
            prompt_hash=rendered.prompt_hash,
            section=section_id,
        )
        if crash_after_model_call and not kitaru.is_replay():
            # testing hook (build prompt 5.3 crash test): same guarded
            # os._exit pattern proven in 3.1's demo.py — is_replay() keeps a
            # resumed execution from crashing itself again
            print("simulated crash (kill -9) mid-section, after the model call", flush=True)
            os._exit(13)

        meta_failure = validate_section_meta(materialize(generated))
        if meta_failure:
            failure_report = meta_failure
            continue

        root_failure = validate_root_proposal(section_id, proposals_of(materialize(generated)))
        if root_failure:
            failure_report = root_failure
            continue

        if assemble_index:
            write_section_output(project_dir, generated, attempt, route_slug=route_slug)
        else:
            write_section_only(project_dir, generated, attempt, route_slug=route_slug)

        manifest_result = materialize(
            commit_section_manifest(
                project_dir,
                generated,
                attempt,
                regen_section=section_id if is_regen else "",
                owner=owner,
            )
        )
        if not manifest_result["ok"]:
            failure_report = "\n".join(
                f"- manifest: {issue['message']}" for issue in manifest_result["issues"]
            )
            continue

        report = materialize(
            run_gates_step(
                project_dir,
                run_id,
                attempt,
                model_result=generated if is_regen else None,
                overridden_ids=regen_overridden_ids if is_regen else None,
                section=section_id,
                # fan-out (assemble_index=False): sibling page workers are
                # concurrently mutating the rest of the project, so this
                # section's own check must be scoped to its own route, and
                # its own root id isn't literally attached until the page
                # is assembled later — see run_gates_step's doc comment
                scope_route=None if assemble_index else route_slug,
                skip_missing_check=not assemble_index,
            )
        )
        if report["passed"]:
            return {
                "passed": True,
                "attempts": attempt,
                "project_dir": project_dir,
                "orphanedOverrides": report.get("declaredOrphans", []),
                "tombstoned": manifest_result.get("tombstoned", []),
                "sectionMeta": materialize(generated)["data"]["sectionMeta"],
            }

        failure_report = format_gate_failures(report)
        rollback_manifest(
            project_dir,
            manifest_result["previous_manifest"],
            attempt,
            proposals=None if is_regen else proposals_of(materialize(generated)),
            owner=owner,
        )

    # max retries exhausted: surfaced to the caller; the site continues
    # (pipeline 5.4). In fan-out mode nothing will ever reference this
    # section again — its last (failed) attempt's own files must not
    # linger on disk, or their still-present data-node-id attributes trip
    # gate 4 forever even though the page assembles a placeholder instead.
    if not assemble_index:
        last_component = materialize(generated)["data"].get("sectionMeta", {}).get("component")
        if last_component:
            page = Path(project_dir) / "src" / "pages" / route_slug
            (page / "sections" / f"{last_component}.tsx").unlink(missing_ok=True)
            (page / "mock" / f"{last_component}.data.ts").unlink(missing_ok=True)

    return {
        "passed": False,
        "attempts": MAX_ATTEMPTS,
        "project_dir": project_dir,
        "failure_report": failure_report,
    }
