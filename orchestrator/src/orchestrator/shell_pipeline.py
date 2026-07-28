"""Shell Agent (pipeline 2.4, build prompt 5.3): reads brief, siteplan,
tokens, primitive inventory; writes shell/ (sole owner); emits routes.ts as
the ground-truth route table.

routes.ts is DETERMINISTIC — built by the orchestrator, never model-authored
— so it can never drift from the plan (the failure mode "nav links to a
route the planner didn't approve" becomes structurally impossible, and gate
2's href check against routes.ts stays meaningful). The LLM (mid tier,
"constrained, template-like" per pipeline section 3) authors only
AppShell.tsx/Nav.tsx/Footer.tsx, styled with tokens and primitives, importing
`{ routes } from "./routes"` and mapping over it — exactly the fixture's own
hand-written shell, which serves as the canonical example.
"""

import json
import shutil
import subprocess
from pathlib import Path

import kitaru
from kitaru import checkpoint, flow

from orchestrator.model_call import call_model_structured_impl
from orchestrator.runlog import append_run_event, default_run_log_path
from orchestrator.section_pipeline import COMPILER_DIR, MAX_ATTEMPTS, _run_compiler_cli, materialize

EXPECTED_SHELL_FILES = {"src/shell/AppShell.tsx", "src/shell/Nav.tsx", "src/shell/Footer.tsx"}

SHELL_TOOL = {
    "type": "object",
    "properties": {
        "files": {
            "type": "object",
            "description": "src/shell/{AppShell,Nav,Footer}.tsx -> complete file content, exactly 3 entries",
            "additionalProperties": {"type": "string"},
        },
    },
    "required": ["files"],
}

SHELL_SYSTEM = '''You are the Shell Agent of an automated website generator. Emit the layout
frame every page renders inside: AppShell (nav + outlet + footer), Nav, and
Footer (codegen contract section 2). This is constrained, template-like
work — routes.ts (the ground-truth route table) is provided to you
READ-ONLY; you import it, you never invent or omit a route.

Rules (machine-checked):
- Emit EXACTLY these 3 files: src/shell/AppShell.tsx, src/shell/Nav.tsx, src/shell/Footer.tsx.
- Nav and Footer import `{{ routes }}` from "./routes" and map over it for every internal link. NEVER hardcode a route path, and NEVER link to a path absent from routes.
- Style ONLY with Tailwind utilities over the token CSS variables in DESIGN CONTEXT. NEVER raw hex, NEVER raw px.
- Compose ONLY the primitives listed in DESIGN CONTEXT, imported from ../primitives/<Name>.
- Shell elements carry no data-node-id/nodeId — the shell is not canvas-editable in v1.
- AppShell accepts `{{ children }}: {{ children: ReactNode }}` and renders Nav, then <main>{{children}}</main>, then Footer.

OUTPUT FORMAT: respond with exactly one JSON object, no other prose:
{{ "files": {{ "src/shell/AppShell.tsx": "...", "src/shell/Nav.tsx": "...", "src/shell/Footer.tsx": "..." }} }}

Canonical example (a previous gate-passing shell for a single-route site;
match its structure and discipline, adapt content to THIS brief and route
table):

src/shell/Nav.tsx:
```tsx
import Container from "../primitives/Container";
import {{ routes }} from "./routes";

export default function Nav() {{
  return (
    <header className="border-b border-solid border-(--color-semantic-border) bg-(--color-semantic-surface)">
      <Container className="flex items-center justify-between py-(--space-4)">
        <a href="/" className="font-(family-name:--typography-fontFamily-heading) text-(length:--typography-scale-lg) font-(--typography-weight-bold) text-(--color-semantic-text) no-underline">
          {{brandName}}
        </a>
        <nav className="flex gap-(--space-6)">
          {{routes.map((route) => (
            <a key={{route.slug}} href={{route.path}} className="text-(length:--typography-scale-sm) text-(--color-semantic-textMuted) no-underline">
              {{route.title}}
            </a>
          ))}}
        </nav>
      </Container>
    </header>
  );
}}
```
(Footer follows the same route-mapping pattern; AppShell composes Nav + main + Footer.)

BRAND: {brand_name}
'''


def validate_shell_output(files: dict[str, str]) -> list[str]:
    issues: list[str] = []
    provided = set(files)
    for missing in sorted(EXPECTED_SHELL_FILES - provided):
        issues.append(f"missing shell file {missing} (the set is fixed: AppShell, Nav, Footer)")
    for stray in sorted(provided - EXPECTED_SHELL_FILES):
        if stray == "src/shell/routes.ts":
            issues.append(
                "src/shell/routes.ts must not be emitted: it is written deterministically by the "
                "orchestrator from the site plan, never by the Shell Agent"
            )
        else:
            issues.append(f"unexpected file {stray}: the Shell Agent writes only src/shell/*.tsx")
    return issues


def build_routes_ts(routes: list[dict]) -> str:
    """The ground-truth route table (contract section 2) — never model-authored."""
    entries = ",\n".join(
        f'  {{ slug: "{r["slug"]}", path: "{r["path"]}", title: "{r["title"]}" }}' for r in routes
    )
    return (
        "/** Ground-truth route table (contract section 2), generated from the "
        "approved site plan. Never hand-edited; never model-authored. */\n"
        "export interface RouteDef {\n"
        "  slug: string;\n"
        "  path: string;\n"
        "  title: string;\n"
        "}\n\n"
        f"export const routes: RouteDef[] = [\n{entries},\n];\n"
    )


# ---------- checkpointed steps ----------


@checkpoint
def generate_shell(
    run_id: str, brief_json: str, routes_ts: str, token_summary: str, attempt: int, failure_report: str
) -> dict:
    brand_name = json.loads(brief_json).get("brand", {}).get("name", "the brand")
    user = f"Brand brief:\n{brief_json}\n\nroutes.ts (read-only, import from it):\n{routes_ts}\n\nTOKENS:\n{token_summary}"
    if failure_report:
        user += f"\n\nPREVIOUS ATTEMPT FAILED VALIDATION. Fix every issue:\n{failure_report}"
    result = call_model_structured_impl(
        role="shell",
        system=SHELL_SYSTEM.format(brand_name=brand_name),
        user=user,
        tool_name="emit_shell",
        tool_description="Emit AppShell.tsx, Nav.tsx, Footer.tsx.",
        tool_schema=SHELL_TOOL,
        max_tokens=6000,
    )
    append_run_event(
        default_run_log_path(run_id),
        run_id=run_id,
        event_type="shell.complete",
        attempt=attempt,
        model=result["model"],
        usage=result["usage"],
        raw_output=json.dumps(result["data"], indent=2),
        checkpoint_ref=f"{kitaru.current_execution_id()}/generate_shell#a{attempt}",
    )
    return result["data"]


@checkpoint
def write_shell(project_dir: str, routes_ts: str, shell_result: dict, attempt: int) -> dict:
    project = Path(project_dir)
    shell_dir = project / "src" / "shell"
    if shell_dir.exists():
        shutil.rmtree(shell_dir)
    shell_dir.mkdir(parents=True)
    (shell_dir / "routes.ts").write_text(routes_ts, encoding="utf-8", newline="\n")
    for rel_path, content in shell_result["files"].items():
        (project / rel_path).write_text(content, encoding="utf-8", newline="\n")

    ensure_node_modules(project)
    tsc = subprocess.run(
        ["cmd", "/c", "npx", "tsc", "--noEmit"], cwd=project, capture_output=True, text=True, encoding="utf-8", timeout=300
    )
    issues: list[str] = []
    if tsc.returncode != 0:
        issues.extend(f"typecheck: {line}" for line in tsc.stdout.splitlines() if line.strip())

    gates = _run_compiler_cli(["scripts/gates.ts", str(project), "--json"])
    gate_report = json.loads(gates.stdout)
    issues.extend(
        f"gate {gate['gate']} ({gate['name']}): {failure['message']}"
        for gate in gate_report["gates"]
        for failure in gate["failures"]
    )
    return {"ok": not issues, "issues": issues[:20]}


def ensure_node_modules(project_dir: Path) -> None:
    from orchestrator.fixture_context import FIXTURE_DIR

    target = project_dir / "node_modules"
    if not target.exists():
        subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(target), str(FIXTURE_DIR / "node_modules")],
            check=True,
            capture_output=True,
        )


# ---------- the flow ----------


@flow
def generate_shell_flow(run_id: str, brief_json: str, siteplan_json: str) -> dict:
    """Reuses the same generated workspace the Design System Agent built for
    this run (tokens/primitives already present) — no workspace reset here."""
    print(f"exec_id: {kitaru.current_execution_id()}", flush=True)
    from orchestrator.design_context import build_design_context
    from orchestrator.section_pipeline import GENERATED_DIR

    project_dir = str(GENERATED_DIR / run_id)
    routes = [
        {"slug": r["slug"], "path": r["path"], "title": r["title"]}
        for r in json.loads(siteplan_json)["routes"]
    ]
    routes_ts = build_routes_ts(routes)

    tokens = json.loads((Path(project_dir) / "src" / "tokens" / "tokens.json").read_text(encoding="utf-8"))
    inventory_path = Path(project_dir) / "design-inventory.json"
    signatures = (
        json.loads(inventory_path.read_text(encoding="utf-8"))["primitives"]
        if inventory_path.exists()
        else []
    )
    token_summary = build_design_context(tokens, signatures)

    failure_report = ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        shell_result = materialize(
            generate_shell(run_id, brief_json, routes_ts, token_summary, attempt, failure_report)
        )
        issues = validate_shell_output(shell_result.get("files", {}))
        if not issues:
            written = materialize(write_shell(project_dir, routes_ts, shell_result, attempt))
            if written["ok"]:
                return {"passed": True, "project_dir": project_dir, "attempts": attempt, "routes": routes}
            issues = written["issues"]
        failure_report = "\n".join(f"- {issue}" for issue in issues)

    return {"passed": False, "failureReport": failure_report}
