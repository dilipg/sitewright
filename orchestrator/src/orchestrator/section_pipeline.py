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
from orchestrator.prompts import load_template, render_template
from orchestrator.runlog import append_run_event, default_run_log_path

REPO_ROOT = ORCHESTRATOR_ROOT.parent
COMPILER_DIR = REPO_ROOT / "compiler"
GENERATED_DIR = REPO_ROOT / "generated"

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


def prepare_workspace_dir(project_dir: str) -> str:
    """Fixture copy with a blank page: tokens/primitives/shell stay
    hand-written (M3 stub table); pages/home content, manifest, and
    overrides are emptied. Full replace — idempotent under replay."""
    target = Path(project_dir)
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(
        FIXTURE_DIR,
        target,
        ignore=shutil.ignore_patterns("node_modules", "dist", "sections", "mock"),
    )
    home = target / "src" / "pages" / "home"
    index = home / "index.tsx"
    index.unlink(missing_ok=True)
    (target / "manifest.json").write_text(
        json.dumps({"version": 1, "nodes": {}}, indent=2) + "\n", encoding="utf-8"
    )
    (target / "overrides" / "home.overrides.json").write_text(
        json.dumps({"version": 1, "route": "/", "overrides": []}, indent=2) + "\n",
        encoding="utf-8",
    )
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
        f"export default function {route_slug.capitalize()}Page() {{\n"
        f'  return <{component} nodeId="{route_slug}.{section_slug}" {{...{data_var}}} />;\n'
        "}\n"
    )


def format_gate_failures(report: dict) -> str:
    lines = []
    for gate in report.get("gates", []):
        for failure in gate.get("failures", []):
            lines.append(f"- gate {gate['gate']} ({gate['name']}): {failure['message']}")
    return "\n".join(lines)


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
        timeout=300,
    )


# ---------- checkpointed steps ----------


@checkpoint
def prepare_workspace(run_id: str) -> str:
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
) -> dict:
    result = call_model_structured_impl(
        role="page",
        system=system,
        user=user,
        tool_name="emit_section",
        tool_description="Emit the generated section: files, manifest proposals, section metadata.",
        tool_schema=SECTION_TOOL_SCHEMA,
    )
    append_run_event(
        default_run_log_path(run_id),
        run_id=run_id,
        event_type="section.generated",
        section="home.hero",
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
        checkpoint_ref=f"{kitaru.current_execution_id()}/generate_section#a{attempt}",
    )
    return result


@checkpoint
def write_section_output(project_dir: str, model_result: dict, attempt: int) -> dict:
    """Writes the generated files + deterministic index.tsx. The section's
    sections/ and mock/ dirs are fully replaced (pipeline 5.3)."""
    data = model_result["data"]
    home = Path(project_dir) / "src" / "pages" / "home"
    for sub in ("sections", "mock"):
        if (home / sub).exists():
            shutil.rmtree(home / sub)

    written = []
    for rel_path, content in data["files"].items():
        target = Path(project_dir) / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="\n")
        written.append(rel_path)

    meta = data["sectionMeta"]
    index_source = build_index_source(
        route_slug="home", section_slug=meta["slug"], component=meta["component"]
    )
    (home / "index.tsx").write_text(index_source, encoding="utf-8", newline="\n")
    return {"written": sorted(written), "sectionMeta": meta}


@checkpoint
def commit_section_manifest(project_dir: str, model_result: dict, attempt: int) -> dict:
    """Validates + commits proposals through the manifest service CLI —
    manifest.json changes only through the service (contract 5.4). Returns
    the pre-commit manifest so a failed attempt can be rolled back."""
    manifest_path = Path(project_dir) / "manifest.json"
    previous = manifest_path.read_text(encoding="utf-8")

    proposals_file = Path(project_dir) / ".proposals.json"
    proposals_file.write_text(
        json.dumps(model_result["data"]["manifestProposals"]), encoding="utf-8"
    )
    result = _run_compiler_cli(
        ["scripts/manifest.ts", "commit", project_dir, "--proposals", str(proposals_file), "--owner", "page:home"]
    )
    proposals_file.unlink(missing_ok=True)
    try:
        payload = json.loads(result.stdout.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        raise RuntimeError(f"manifest CLI produced no result: {result.stderr}") from None
    return {"ok": payload["ok"], "issues": payload["issues"], "previous_manifest": previous}


@checkpoint
def run_gates_step(project_dir: str, run_id: str, attempt: int) -> dict:
    result = _run_compiler_cli(["scripts/gates.ts", project_dir, "--json"])
    report = json.loads(result.stdout)
    append_run_event(
        default_run_log_path(run_id),
        run_id=run_id,
        event_type="section.validated",
        section="home.hero",
        attempt=attempt,
        gate_results={
            "passed": report["passed"],
            "failures": [f for gate in report["gates"] for f in gate["failures"]],
        },
        checkpoint_ref=f"{kitaru.current_execution_id()}/run_gates_step#a{attempt}",
    )
    return report


@checkpoint
def rollback_manifest(project_dir: str, previous_manifest: str, attempt: int) -> bool:
    """Restores the manifest service's pre-attempt state after a failed
    attempt: proposals only stay committed at section.validated."""
    (Path(project_dir) / "manifest.json").write_text(previous_manifest, encoding="utf-8")
    return True


# ---------- the flow ----------


@flow
def generate_section_flow(
    run_id: str,
    page_brief: str,
    section_brief: str,
) -> dict:
    print(f"exec_id: {kitaru.current_execution_id()}", flush=True)
    project_dir = materialize(prepare_workspace(run_id))

    template = load_template("hero")
    rendered = render_template(
        template,
        {
            "design_context": build_design_context(
                fixture_tokens(), fixture_primitive_signatures()
            ),
            "route_slug": "home",
            "route_path": "/",
            "page_brief": page_brief,
            "prior_sections": "(none — this is the first section on the page)",
            "route_table": fixture_route_table(),
            "section_slug": "hero",
            "section_brief": section_brief,
            "regen_block": "(first generation — no regeneration context)",
        },
    )

    failure_report = ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        user = user_prompt_with_failures(rendered.user, failure_report)
        generated = generate_section(
            run_id=run_id,
            attempt=attempt,
            system=rendered.system,
            user=user,
            template_name=rendered.template_name,
            template_version=rendered.template_version,
            template_hash=rendered.template_hash,
            prompt_hash=rendered.prompt_hash,
        )
        write_section_output(project_dir, generated, attempt)

        manifest_result = materialize(commit_section_manifest(project_dir, generated, attempt))
        if not manifest_result["ok"]:
            failure_report = "\n".join(
                f"- manifest: {issue['message']}" for issue in manifest_result["issues"]
            )
            continue

        report = materialize(run_gates_step(project_dir, run_id, attempt))
        if report["passed"]:
            return {"passed": True, "attempts": attempt, "project_dir": project_dir}

        failure_report = format_gate_failures(report)
        rollback_manifest(project_dir, manifest_result["previous_manifest"], attempt)

    # max retries exhausted: surfaced to the caller; the site continues (pipeline 5.4)
    return {
        "passed": False,
        "attempts": MAX_ATTEMPTS,
        "project_dir": project_dir,
        "failure_report": failure_report,
    }
