# Prompt-Driven Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user change a generated site by typing an instruction, which compiles to the same override operations the canvas already produces.

**Architecture:** A structured tool-call agent in the orchestrator resolves an instruction against a projection of the route's manifest nodes and returns typed *operations*. The preview server exposes it at `POST /__edit-prompt` using the same spawn plumbing as `/__regen`. The **editor** validates those operations against the manifest and applies them through its existing store functions as a single undo entry — so override files keep exactly one writer.

**Tech Stack:** Python 3.12 / uv / pytest (orchestrator), TypeScript / vitest (compiler, editor), Playwright (e2e), Kitaru (flows), Anthropic API via the existing `call_model_structured_impl` adapter.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-03-prompt-driven-editing-design.md`. Where this plan and the spec disagree, the spec wins.
- **Only the editor writes override files.** The agent returns operations, never files. (Contract section 2 ownership map.)
- **All-or-nothing per prompt.** If any operation fails validation, none are applied. One prompt = one `pushHistory` entry.
- **Tokens-only by default.** The `style` operation takes a token *path* that must exist in the project's `tokens.json`. Raw values require the separate `styleExact` operation.
- A node may only be edited through a channel listed in its manifest `editable` array.
- Red tests never cross a commit boundary. Commit after each task.
- Verify with `npm run check` from the repo root before the final commit of each task that touches more than one package.
- Do not modify `docs/codegen-contract-v1.md`, `docs/agent-pipeline-spec-v1.md`, `docs/canvas-editor-prd-v1.md`, or `docs/build-plan-v1.md`. If they appear to conflict, stop and report.

---

## File Structure

| File | Responsibility |
|---|---|
| `orchestrator/src/orchestrator/edit_context.py` | **Create.** Pure: build the route projection and token vocabulary sent to the model. |
| `orchestrator/tests/test_edit_context.py` | **Create.** Tests for the above. |
| `orchestrator/src/orchestrator/edit_agent.py` | **Create.** Tool schema, the model call, escalation, CLI entry point. |
| `orchestrator/tests/test_edit_agent.py` | **Create.** Tests with the model call stubbed. |
| `orchestrator/src/orchestrator/config.py` | **Modify.** Add `edit` and `edit-escalated` roles to `ROLE_TIERS`. |
| `compiler/src/regen-api.ts` | **Modify.** Add `POST /__edit-prompt` (real + mock modes). |
| `compiler/src/edit-mock.ts` | **Create.** Deterministic operation source for mock mode, unit-testable. |
| `compiler/src/edit-mock.test.ts` | **Create.** Tests for the above. |
| `editor/src/lib/edit-ops.ts` | **Create.** Operation types, `validateEditOperations`, `applyEditOperations`. |
| `editor/src/lib/edit-ops.test.ts` | **Create.** Every validation rejection rule. |
| `editor/src/components/EditPrompt.tsx` | **Create.** Prompt box, result summary, clarify and structural states. |
| `editor/src/App.tsx` | **Modify.** State, fetch, validate, apply as one history entry. |
| `editor/e2e/edit-prompt.spec.ts` | **Create.** e2e against mock mode. |
| `editor/e2e/invariant-cases.ts` | **Modify.** One prompt-driven invariant case. |

---

### Task 1: Route projection and token vocabulary

The model needs to know what it may edit. This task builds that input and nothing else — it makes no model call, so it is fast to test and is where the token budget is actually decided.

**Files:**
- Create: `orchestrator/src/orchestrator/edit_context.py`
- Test: `orchestrator/tests/test_edit_context.py`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `build_route_projection(project_dir: Path, route: str, selection: str | None = None) -> list[dict]` — each dict is `{"nodeId": str, "element": str, "editable": list[str], "text": str | None}`.
  - `token_vocabulary(project_dir: Path) -> list[str]` — sorted dotted token paths, e.g. `["color.semantic.accent", "space.4", …]`.

- [ ] **Step 1: Write the failing tests**

```python
# orchestrator/tests/test_edit_context.py
"""The input the edit agent is given. This is where the token budget is
decided, so the tests are about what is INCLUDED and what is left out."""

import json
from pathlib import Path

from orchestrator.edit_context import build_route_projection, token_vocabulary


def scaffold(tmp_path: Path) -> Path:
    project = tmp_path / "run"
    (project / "src" / "pages" / "home" / "mock").mkdir(parents=True)
    (project / "src" / "tokens").mkdir(parents=True)
    (project / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "home.hero": {
                        "route": "/", "file": "src/pages/home/sections/Hero.tsx",
                        "component": "Hero", "element": "section",
                        "editable": ["style", "layout", "visibility"], "status": "active",
                    },
                    "home.hero.headline": {
                        "route": "/", "file": "src/pages/home/sections/Hero.tsx",
                        "component": "Hero", "element": "Heading",
                        "editable": ["text", "style", "layout", "visibility"], "status": "active",
                    },
                    "home.hero.retired": {
                        "route": "/", "file": "src/pages/home/sections/Hero.tsx",
                        "component": "Hero", "element": "Text",
                        "editable": ["text"], "status": "tombstoned",
                    },
                    "shop.grid": {
                        "route": "/shop", "file": "src/pages/shop/sections/Grid.tsx",
                        "component": "Grid", "element": "section",
                        "editable": ["style"], "status": "active",
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    (project / "src" / "pages" / "home" / "mock" / "Hero.data.ts").write_text(
        'export const heroData = {\n  headline: "Understand your product in minutes",\n};\n',
        encoding="utf-8",
    )
    (project / "src" / "tokens" / "tokens.json").write_text(
        json.dumps({"color": {"semantic": {"accent": "#4f46e5", "bg": "#ffffff"}}, "space": {"4": "1rem"}}),
        encoding="utf-8",
    )
    return project


def test_projection_covers_the_routes_active_nodes(tmp_path: Path) -> None:
    projection = build_route_projection(scaffold(tmp_path), "home")
    assert [node["nodeId"] for node in projection] == ["home.hero", "home.hero.headline"]


def test_projection_excludes_other_routes_and_tombstoned_nodes(tmp_path: Path) -> None:
    """A tombstoned node cannot be edited, and another route's nodes are not
    addressable from this prompt — including either would spend tokens on
    targets the agent must never choose."""
    ids = {node["nodeId"] for node in build_route_projection(scaffold(tmp_path), "home")}
    assert "home.hero.retired" not in ids
    assert "shop.grid" not in ids


def test_projection_carries_editable_channels_and_element(tmp_path: Path) -> None:
    projection = build_route_projection(scaffold(tmp_path), "home")
    headline = next(node for node in projection if node["nodeId"] == "home.hero.headline")
    assert headline["element"] == "Heading"
    assert headline["editable"] == ["text", "style", "layout", "visibility"]


def test_projection_carries_current_text_for_text_editable_nodes(tmp_path: Path) -> None:
    """'Make the headline shorter' is unanswerable without the current text."""
    projection = build_route_projection(scaffold(tmp_path), "home")
    headline = next(node for node in projection if node["nodeId"] == "home.hero.headline")
    assert headline["text"] == "Understand your product in minutes"
    section = next(node for node in projection if node["nodeId"] == "home.hero")
    assert section["text"] is None, "a node with no text channel carries no text"


def test_long_text_is_truncated(tmp_path: Path) -> None:
    project = scaffold(tmp_path)
    long_value = "x" * 500
    (project / "src" / "pages" / "home" / "mock" / "Hero.data.ts").write_text(
        f'export const heroData = {{\n  headline: "{long_value}",\n}};\n', encoding="utf-8"
    )
    projection = build_route_projection(project, "home")
    headline = next(node for node in projection if node["nodeId"] == "home.hero.headline")
    assert len(headline["text"]) <= 83, "80 chars plus an ellipsis"
    assert headline["text"].endswith("…")


def test_a_selection_narrows_the_projection_to_that_subtree(tmp_path: Path) -> None:
    """Selection narrows both what the agent SEES and what it may target."""
    projection = build_route_projection(scaffold(tmp_path), "home", selection="home.hero.headline")
    assert [node["nodeId"] for node in projection] == ["home.hero.headline"]


def test_token_vocabulary_is_sorted_dotted_paths(tmp_path: Path) -> None:
    assert token_vocabulary(scaffold(tmp_path)) == [
        "color.semantic.accent",
        "color.semantic.bg",
        "space.4",
    ]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `uv run --directory orchestrator pytest tests/test_edit_context.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'orchestrator.edit_context'`

- [ ] **Step 3: Write the implementation**

```python
# orchestrator/src/orchestrator/edit_context.py
"""What the edit agent is shown.

Kept separate from the agent itself because this is where the token budget is
actually decided, and because it is pure: no model call, no I/O beyond reading
the project, so it can be tested exhaustively and cheaply.

The projection is deliberately narrow. Every node it includes is a node the
agent may target, so anything it must never choose — another route, a
tombstoned node — is left out rather than filtered later.
"""

import json
import re
from pathlib import Path

TEXT_LIMIT = 80

# `headline: "..."` in a mock data file. Deliberately a regex and not an AST
# parse: this is a hint for the model, not a compilation step. A miss costs the
# agent some context; it cannot produce a wrong edit, because every operation is
# validated against the manifest before anything is applied.
_FIELD = r'{field}\s*:\s*"((?:[^"\\]|\\.)*)"'


def _read_text_value(project_dir: Path, node: dict, field: str) -> str | None:
    mock = project_dir / Path(node["file"]).parent.parent / "mock" / f"{node['component']}.data.ts"
    if not mock.exists():
        return None
    match = re.search(_FIELD.format(field=re.escape(field)), mock.read_text(encoding="utf-8"))
    if match is None:
        return None
    value = match.group(1)
    return value if len(value) <= TEXT_LIMIT else value[:TEXT_LIMIT] + "…"


def build_route_projection(
    project_dir: Path, route: str, selection: str | None = None
) -> list[dict]:
    """The route's editable nodes, as the agent sees them."""
    manifest = json.loads((project_dir / "manifest.json").read_text(encoding="utf-8"))
    projection: list[dict] = []
    for node_id, node in manifest["nodes"].items():
        if node["status"] != "active":
            continue
        if not (node_id == route or node_id.startswith(f"{route}.")):
            continue
        if selection is not None and not (
            node_id == selection or node_id.startswith(f"{selection}.")
        ):
            continue
        text = (
            _read_text_value(project_dir, node, node_id.rsplit(".", 1)[-1])
            if "text" in node["editable"]
            else None
        )
        projection.append(
            {
                "nodeId": node_id,
                "element": node["element"],
                "editable": list(node["editable"]),
                "text": text,
            }
        )
    return projection


def token_vocabulary(project_dir: Path) -> list[str]:
    """Every token path the style operation may name, as dotted strings.

    The paths only — not `tokens.json` wholesale. The agent needs to know which
    tokens EXIST; their values are the design system's business.
    """
    tokens = json.loads(
        (project_dir / "src" / "tokens" / "tokens.json").read_text(encoding="utf-8")
    )

    def walk(value: object, prefix: list[str]) -> list[str]:
        if not isinstance(value, dict):
            return [".".join(prefix)]
        return [path for key, child in value.items() for path in walk(child, [*prefix, key])]

    return sorted(walk(tokens, []))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `uv run --directory orchestrator pytest tests/test_edit_context.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add orchestrator/src/orchestrator/edit_context.py orchestrator/tests/test_edit_context.py
git commit -m "feat(edit): route projection and token vocabulary for the edit agent"
```

---

### Task 2: The edit agent

The model call, its schema, escalation, and a CLI the preview server can spawn.

**Files:**
- Create: `orchestrator/src/orchestrator/edit_agent.py`
- Modify: `orchestrator/src/orchestrator/config.py` (add two roles to `ROLE_TIERS`)
- Test: `orchestrator/tests/test_edit_agent.py`

**Interfaces:**
- Consumes: `build_route_projection`, `token_vocabulary` from Task 1.
- Produces: `resolve_edit(run_id: str, route: str, instruction: str, selection: str | None = None) -> dict` returning `{"operations": [...], "clarify": str | None, "structural": dict | None, "notes": str, "model": str}`. CLI prints `EDIT_RESULT <json>`.

- [ ] **Step 1: Add the roles**

In `orchestrator/src/orchestrator/config.py`, extend `ROLE_TIERS`:

```python
ROLE_TIERS: dict[str, str] = {
    "intake": "mid",
    "planner": "mid",
    "design-system": "top",
    "shell": "mid",
    "page": "top",
    "export-cleanup": "small",
    # Prompt-driven editing. Resolving an instruction to {node, channel, token}
    # is lookup and mapping, not authoring — the design system supplies the
    # values — so it runs on the mid tier. `edit-escalated` is the single retry
    # on the top tier when the mid tier returns nothing usable. Two roles rather
    # than one so record_usage attributes their cost separately and the
    # escalation rate is visible in the run log.
    "edit": "mid",
    "edit-escalated": "top",
}
```

- [ ] **Step 2: Write the failing tests**

```python
# orchestrator/tests/test_edit_agent.py
"""The edit agent. The model call is stubbed throughout — what is testable here
is the schema we ask for, how a response is interpreted, and when we escalate."""

import json
from pathlib import Path

import pytest

from orchestrator import edit_agent


def project(tmp_path: Path) -> Path:
    directory = tmp_path / "generated" / "run"
    (directory / "src" / "tokens").mkdir(parents=True)
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "home.hero.headline": {
                        "route": "/", "file": "src/pages/home/sections/Hero.tsx",
                        "component": "Hero", "element": "Heading",
                        "editable": ["text", "style"], "status": "active",
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    (directory / "src" / "tokens" / "tokens.json").write_text(
        json.dumps({"color": {"semantic": {"accent": "#4f46e5"}}}), encoding="utf-8"
    )
    return directory


def stub(monkeypatch, responses: list[dict]) -> list[str]:
    """Replaces the model call with a scripted sequence; records roles used."""
    roles: list[str] = []

    def fake(**kwargs):
        roles.append(kwargs["role"])
        return {"data": responses[len(roles) - 1], "model": "stub", "usage": {}}

    monkeypatch.setattr(edit_agent, "call_model_structured_impl", fake)
    return roles


def test_operations_are_returned_as_given(tmp_path, monkeypatch) -> None:
    directory = project(tmp_path)
    monkeypatch.setattr(edit_agent, "GENERATED_DIR", directory.parent)
    stub(monkeypatch, [{"operations": [{"op": "text", "nodeId": "home.hero.headline", "value": "Shorter"}], "notes": "ok"}])

    result = edit_agent.resolve_edit("run", "home", "shorten the headline")
    assert result["operations"] == [{"op": "text", "nodeId": "home.hero.headline", "value": "Shorter"}]
    assert result["clarify"] is None
    assert result["structural"] is None


def test_the_mid_tier_runs_first(tmp_path, monkeypatch) -> None:
    directory = project(tmp_path)
    monkeypatch.setattr(edit_agent, "GENERATED_DIR", directory.parent)
    roles = stub(monkeypatch, [{"operations": [{"op": "visibility", "nodeId": "home.hero.headline", "hidden": True}], "notes": "ok"}])

    edit_agent.resolve_edit("run", "home", "hide the headline")
    assert roles == ["edit"], "no escalation when the first call resolves"


def test_an_empty_result_escalates_once(tmp_path, monkeypatch) -> None:
    """Escalation is for instructions the cheap tier could not resolve — not a
    retry loop. Exactly one, then report."""
    directory = project(tmp_path)
    monkeypatch.setattr(edit_agent, "GENERATED_DIR", directory.parent)
    roles = stub(
        monkeypatch,
        [
            {"operations": [], "notes": "could not resolve"},
            {"operations": [{"op": "text", "nodeId": "home.hero.headline", "value": "Shorter"}], "notes": "ok"},
        ],
    )

    result = edit_agent.resolve_edit("run", "home", "make it feel calmer")
    assert roles == ["edit", "edit-escalated"]
    assert len(result["operations"]) == 1


def test_a_clarify_response_does_NOT_escalate(tmp_path, monkeypatch) -> None:
    """Asking a question is a successful outcome, not a failure to resolve.
    Escalating would pay the top tier to ask the same question again."""
    directory = project(tmp_path)
    monkeypatch.setattr(edit_agent, "GENERATED_DIR", directory.parent)
    roles = stub(monkeypatch, [{"operations": [], "clarify": "which button?", "notes": "ambiguous"}])

    result = edit_agent.resolve_edit("run", "home", "make the button green")
    assert roles == ["edit"]
    assert result["clarify"] == "which button?"


def test_a_structural_response_does_NOT_escalate(tmp_path, monkeypatch) -> None:
    directory = project(tmp_path)
    monkeypatch.setattr(edit_agent, "GENERATED_DIR", directory.parent)
    roles = stub(
        monkeypatch,
        [{"operations": [], "structural": {"kind": "add-section", "route": "home", "archetype": "social-proof", "reason": "needs generation"}, "notes": "structural"}],
    )

    result = edit_agent.resolve_edit("run", "home", "add a testimonials section")
    assert roles == ["edit"]
    assert result["structural"]["kind"] == "add-section"


def test_both_escalation_attempts_failing_reports_rather_than_raising(tmp_path, monkeypatch) -> None:
    directory = project(tmp_path)
    monkeypatch.setattr(edit_agent, "GENERATED_DIR", directory.parent)
    stub(monkeypatch, [{"operations": [], "notes": "no"}, {"operations": [], "notes": "no"}])

    result = edit_agent.resolve_edit("run", "home", "???")
    assert result["operations"] == []
    assert result["clarify"] is not None, "the user gets a sentence, not silence"


def test_the_tool_schema_constrains_style_to_the_projects_own_tokens(tmp_path) -> None:
    """The fidelity guarantee: 'green' can only become a token path that exists
    in this project, never a raw colour."""
    schema = edit_agent.build_tool_schema(["color.semantic.accent", "color.semantic.bg"])
    style = next(
        variant for variant in schema["properties"]["operations"]["items"]["anyOf"]
        if variant["properties"]["op"]["const"] == "style"
    )
    assert style["properties"]["token"]["enum"] == ["color.semantic.accent", "color.semantic.bg"]
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run --directory orchestrator pytest tests/test_edit_agent.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'orchestrator.edit_agent'`

- [ ] **Step 4: Write the implementation**

```python
# orchestrator/src/orchestrator/edit_agent.py
"""Prompt-driven editing (spec: docs/superpowers/specs/2026-08-03-prompt-driven-editing-design.md).

Resolves a natural-language instruction into typed OVERRIDE OPERATIONS against
one route. It returns operations and never writes anything: override files have
exactly one writer, the editor (contract section 2), and keeping that true is
what lets this feature inherit validation, persistence, undo/redo and export
without touching any of them.

Cost shape: the projection and token vocabulary are the bulk of the input and
are identical across every prompt in a session, so they sit at the front of the
system prompt where the provider's prompt cache can serve them. The instruction
is the only variable part.

Usage:
  uv run python -m orchestrator.edit_agent --run-id <run> --route home \\
      --instruction "make the headline shorter"
"""

import argparse
import json
from pathlib import Path

from orchestrator.edit_context import build_route_projection, token_vocabulary
from orchestrator.model_call import call_model_structured_impl
from orchestrator.section_pipeline import GENERATED_DIR

MAX_TOKENS = 2000

_STRUCTURAL_KINDS = ["add-section", "regenerate-section", "regenerate-page"]


def build_tool_schema(tokens: list[str]) -> dict:
    """The operation set, with `style` restricted to THIS project's tokens.

    The enum is the fidelity guarantee: a raw colour is not merely discouraged,
    it is unrepresentable. `styleExact` exists so an explicit "exactly 37px" is
    still possible, and the exporter counts it as off-scale exactly as it counts
    a canvas edit of the same kind.
    """
    node = {"type": "string", "description": "a nodeId from the projection"}
    return {
        "type": "object",
        "properties": {
            "operations": {
                "type": "array",
                "items": {
                    "anyOf": [
                        {
                            "type": "object",
                            "properties": {
                                "op": {"const": "text"},
                                "nodeId": node,
                                "value": {"type": "string"},
                                "key": {"type": "string", "description": 'only "src", for image replace'},
                            },
                            "required": ["op", "nodeId", "value"],
                        },
                        {
                            "type": "object",
                            "properties": {
                                "op": {"const": "style"},
                                "nodeId": node,
                                "property": {"type": "string"},
                                "token": {"type": "string", "enum": tokens},
                            },
                            "required": ["op", "nodeId", "property", "token"],
                        },
                        {
                            "type": "object",
                            "properties": {
                                "op": {"const": "styleExact"},
                                "nodeId": node,
                                "property": {"type": "string"},
                                "value": {"type": "string"},
                            },
                            "required": ["op", "nodeId", "property", "value"],
                        },
                        {
                            "type": "object",
                            "properties": {
                                "op": {"const": "layout"},
                                "nodeId": node,
                                "property": {"type": "string"},
                                "value": {"type": "string"},
                            },
                            "required": ["op", "nodeId", "property", "value"],
                        },
                        {
                            "type": "object",
                            "properties": {
                                "op": {"const": "visibility"},
                                "nodeId": node,
                                "hidden": {"type": "boolean"},
                            },
                            "required": ["op", "nodeId", "hidden"],
                        },
                        {
                            "type": "object",
                            "properties": {
                                "op": {"const": "sectionOrder"},
                                "route": {"type": "string"},
                                "order": {"type": "array", "items": {"type": "string"}},
                            },
                            "required": ["op", "route", "order"],
                        },
                    ]
                },
            },
            "clarify": {"type": "string", "description": "ask when two targets are equally plausible"},
            "structural": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": _STRUCTURAL_KINDS},
                    "route": {"type": "string"},
                    "archetype": {"type": "string"},
                    "reason": {"type": "string"},
                },
                "required": ["kind", "route", "reason"],
            },
            "notes": {"type": "string"},
        },
        "required": ["notes"],
    }


SYSTEM = """You edit an already-generated website by emitting OVERRIDE OPERATIONS.

You never write code and never rewrite a section. You choose existing nodes and
change them through the channels they declare.

Rules, all machine-checked after you answer — a violation means NOTHING is applied:
1. Only use nodeIds present in the NODES list below.
2. Only use a channel listed in that node's `editable` array.
3. For colour, size, spacing and type, use the `style` op with a token from the
   TOKENS list. Never invent a hex colour or a pixel value. The tokens ARE the
   design system; picking from them is what keeps the site coherent.
4. Use `styleExact` ONLY when the user asked for a specific literal value
   ("exactly 37px"). It is recorded as an off-scale edit.
5. `sectionOrder` must list every section on the route, or the export fails.

If two nodes are equally plausible targets, set `clarify` and emit no
operations. Guessing is worse than asking.

If the request needs new or rewritten content — adding a section, changing what
a section IS rather than what it says — set `structural` and emit no operations.
That path costs the user money and they must confirm it.

Otherwise emit operations and a one-line `notes` describing what you did."""


def _render_context(projection: list[dict], tokens: list[str]) -> str:
    lines = ["NODES (nodeId | element | editable | current text):"]
    for node in projection:
        text = f' | "{node["text"]}"' if node["text"] else ""
        lines.append(f'- {node["nodeId"]} | {node["element"]} | {",".join(node["editable"])}{text}')
    lines.append("")
    lines.append(f"TOKENS: {', '.join(tokens)}")
    return "\n".join(lines)


def _normalize(data: dict) -> dict:
    return {
        "operations": data.get("operations") or [],
        "clarify": data.get("clarify") or None,
        "structural": data.get("structural") or None,
        "notes": data.get("notes", ""),
    }


def resolve_edit(
    run_id: str, route: str, instruction: str, selection: str | None = None
) -> dict:
    project_dir = GENERATED_DIR / run_id
    projection = build_route_projection(project_dir, route, selection)
    if not projection:
        return {
            "operations": [], "clarify": None, "structural": None, "model": "",
            "notes": f"route '{route}' has no editable nodes",
        }

    tokens = token_vocabulary(project_dir)
    schema = build_tool_schema(tokens)
    # Context first, instruction last: the context is identical across every
    # prompt in a session, so this ordering is what the prompt cache rewards.
    system = f"{SYSTEM}\n\n{_render_context(projection, tokens)}"

    for role in ("edit", "edit-escalated"):
        result = call_model_structured_impl(
            role=role,
            system=system,
            user=instruction,
            tool_name="emit_edits",
            tool_description="Emit override operations that satisfy the instruction.",
            tool_schema=schema,
            max_tokens=MAX_TOKENS,
        )
        answer = _normalize(result["data"])
        # A clarify or a structural verdict is a SUCCESSFUL outcome; escalating
        # would pay the top tier to ask the same question again.
        if answer["operations"] or answer["clarify"] or answer["structural"]:
            return {**answer, "model": result["model"]}

    return {
        "operations": [], "structural": None, "model": result["model"],
        "clarify": "I could not work out what to change. Try naming the element, e.g. \\"make the hero headline shorter\\".",
        "notes": "unresolved after escalation",
    }


def main() -> None:
    parser = argparse.ArgumentParser(prog="orchestrator.edit_agent")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--route", required=True)
    parser.add_argument("--instruction", required=True)
    parser.add_argument("--selection")
    args = parser.parse_args()

    result = resolve_edit(args.run_id, args.route, args.instruction, args.selection)
    print(json.dumps(result, indent=2))
    print(f"EDIT_RESULT {json.dumps(result)}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run --directory orchestrator pytest tests/test_edit_agent.py tests/test_config.py -v`
Expected: PASS (7 new tests; `test_config.py` still green)

- [ ] **Step 6: Commit**

```bash
git add orchestrator/src/orchestrator/edit_agent.py orchestrator/src/orchestrator/config.py orchestrator/tests/test_edit_agent.py
git commit -m "feat(edit): edit agent with token-constrained schema and one escalation"
```

---

### Task 3: `POST /__edit-prompt` on the preview server

**Files:**
- Create: `compiler/src/edit-mock.ts`
- Create: `compiler/src/edit-mock.test.ts`
- Modify: `compiler/src/regen-api.ts`

**Interfaces:**
- Consumes: the CLI from Task 2 (`orchestrator.edit_agent`, marker `EDIT_RESULT `).
- Produces: `POST /__edit-prompt { route, instruction, selection? }` → `{ operations, clarify, structural, notes }`; and `mockEditOperations(instruction: string, route: string): EditAgentResult` for e2e.

- [ ] **Step 1: Write the failing test**

```typescript
// compiler/src/edit-mock.test.ts
import { describe, expect, it } from "vitest";
import { mockEditOperations } from "./edit-mock";

describe("mockEditOperations", () => {
  it("returns a style operation for a colour instruction", () => {
    const result = mockEditOperations("make the headline accent coloured", "home");
    expect(result.operations).toEqual([
      { op: "style", nodeId: "home.hero.headline", property: "color", token: "color.semantic.accent" },
    ]);
  });

  it("returns a clarify for an ambiguous instruction", () => {
    expect(mockEditOperations("make the button green", "home").clarify).toMatch(/which/i);
  });

  it("returns a structural verdict for an add request", () => {
    const result = mockEditOperations("add a testimonials section", "home");
    expect(result.structural?.kind).toBe("add-section");
    expect(result.operations).toEqual([]);
  });

  it("returns an invalid nodeId when asked to, so the editor's rejection path is testable", () => {
    // The e2e needs a way to exercise all-or-nothing rejection without a model.
    const result = mockEditOperations("INVALID", "home");
    expect(result.operations[0]!.nodeId).toBe("home.does-not-exist");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd compiler && npx vitest run src/edit-mock.test.ts`
Expected: FAIL — cannot resolve `./edit-mock`

- [ ] **Step 3: Write the mock source**

```typescript
// compiler/src/edit-mock.ts
/**
 * Deterministic operations for mock mode (WG_REGEN_MOCK=1), so the editor's
 * prompt UX is e2e-testable without model spend.
 *
 * Keyword-matched on purpose: it is not a second implementation of the agent,
 * it is a fixed set of responses covering each branch the editor must handle —
 * edits, a clarify, a structural verdict, and an invalid batch. Anything it
 * cannot match returns an empty result, which the editor reports as
 * "could not resolve" exactly as a failed real call would.
 */

export interface EditOperation {
  op: "text" | "style" | "styleExact" | "layout" | "visibility" | "sectionOrder";
  nodeId?: string;
  route?: string;
  value?: string;
  property?: string;
  token?: string;
  hidden?: boolean;
  order?: string[];
  key?: string;
}

export interface EditAgentResult {
  operations: EditOperation[];
  clarify?: string;
  structural?: { kind: string; route: string; archetype?: string; reason: string };
  notes: string;
}

export function mockEditOperations(instruction: string, route: string): EditAgentResult {
  const text = instruction.toLowerCase();

  if (instruction.includes("INVALID")) {
    return {
      operations: [{ op: "visibility", nodeId: `${route}.does-not-exist`, hidden: true }],
      notes: "mock: an operation naming an unknown node",
    };
  }
  if (text.includes("add ") && text.includes("section")) {
    return {
      operations: [],
      structural: { kind: "add-section", route, archetype: "social-proof", reason: "adding a section requires generation" },
      notes: "mock: structural request",
    };
  }
  if (text.includes("button")) {
    return { operations: [], clarify: "Which button — the primary or the secondary one?", notes: "mock: ambiguous" };
  }
  if (text.includes("accent") || text.includes("colour") || text.includes("color")) {
    return {
      operations: [
        { op: "style", nodeId: `${route}.hero.headline`, property: "color", token: "color.semantic.accent" },
      ],
      notes: "mock: recoloured the headline",
    };
  }
  if (text.includes("shorter") || text.includes("headline")) {
    return {
      operations: [{ op: "text", nodeId: `${route}.hero.headline`, value: "A shorter headline" }],
      notes: "mock: shortened the headline",
    };
  }
  return { operations: [], notes: "mock: no match" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd compiler && npx vitest run src/edit-mock.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Add the endpoint**

In `compiler/src/regen-api.ts`, extend the header comment's route list with:

```
 *   POST /__edit-prompt  { route, instruction, selection? }
 *                                                 -> { operations, clarify, structural, notes }
```

Add the import at the top:

```typescript
import type { EditAgentResult } from "./edit-mock.ts";
import { mockEditOperations } from "./edit-mock.ts";
```

Add this handler immediately before the `if (req.method === "POST" && url === "/__regen-revert")` block:

```typescript
        if (req.method === "POST" && url === "/__edit-prompt") {
          void readBody(req).then(async (body) => {
            try {
              const { route, instruction, selection } = body as {
                route: string;
                instruction: string;
                selection?: string;
              };
              // No snapshot here, unlike regen: this endpoint changes nothing on
              // disk. It returns operations; the editor applies them as ordinary
              // overrides, which the existing undo stack already covers.
              const result =
                process.env.WG_REGEN_MOCK === "1"
                  ? mockEditOperations(instruction, route)
                  : await realEditPrompt(root, route, instruction, selection);
              respondJson(res, 200, result);
            } catch (error) {
              respondJson(res, 500, { error: String(error) });
            }
          });
          return;
        }
```

Add the real-mode spawn beside `realAddSection`:

```typescript
function realEditPrompt(
  root: string,
  route: string,
  instruction: string,
  selection: string | undefined,
): Promise<EditAgentResult> {
  const scope = ["orchestrator.edit_agent", "--route", route];
  if (selection !== undefined) scope.push("--selection", selection);
  return runCli<EditAgentResult>(root, scope, instruction, "EDIT_RESULT ");
}
```

- [ ] **Step 6: Verify the compiler still typechecks and passes**

Run: `cd compiler && npx tsc --noEmit -p . && npx vitest run`
Expected: PASS, no type errors

- [ ] **Step 7: Commit**

```bash
git add compiler/src/edit-mock.ts compiler/src/edit-mock.test.ts compiler/src/regen-api.ts
git commit -m "feat(edit): /__edit-prompt endpoint with a deterministic mock mode"
```

---

### Task 4: Operation validation and application

The safety layer. This is the task that decides whether a hallucinated node id becomes a caught error or a corrupt override file, so it gets the densest tests.

**Files:**
- Create: `editor/src/lib/edit-ops.ts`
- Test: `editor/src/lib/edit-ops.test.ts`

**Interfaces:**
- Consumes: `OverridesMap` and the store functions from `editor/src/lib/store.ts`; `Manifest` from the compiler; `tokenPathSet` from `editor/src/lib/tokens.ts`.
- Produces:
  - `validateEditOperations(ops: EditOperation[], manifest: Manifest, tokenPaths: Set<string>, route: string): string[]` — returns rejection reasons; empty means valid.
  - `applyEditOperations(map: OverridesMap, ops: EditOperation[], sections: string[]): OverridesMap`.

- [ ] **Step 1: Write the failing tests**

```typescript
// editor/src/lib/edit-ops.test.ts
/**
 * The layer between an agent's answer and the override store. Every test here
 * is a way the agent can be wrong; the product requirement is that being wrong
 * changes nothing at all.
 */
import { describe, expect, it } from "vitest";
import type { Manifest } from "@website-generator/compiler/src/manifest.ts";
import { applyEditOperations, validateEditOperations } from "./edit-ops";

const MANIFEST = {
  version: 1,
  nodes: {
    "home.hero": { route: "/", file: "f", component: "Hero", element: "section", editable: ["style", "layout", "visibility"], status: "active" },
    "home.hero.headline": { route: "/", file: "f", component: "Hero", element: "Heading", editable: ["text", "style"], status: "active" },
    "home.faq": { route: "/", file: "f", component: "Faq", element: "section", editable: ["style"], status: "active" },
    "home.hero.gone": { route: "/", file: "f", component: "Hero", element: "Text", editable: ["text"], status: "tombstoned" },
  },
} as unknown as Manifest;

const TOKENS = new Set(["color.semantic.accent", "space.4"]);
const SECTIONS = ["home.hero", "home.faq"];

describe("validateEditOperations", () => {
  it("accepts an operation on a channel the node declares", () => {
    expect(
      validateEditOperations([{ op: "text", nodeId: "home.hero.headline", value: "Hi" }], MANIFEST, TOKENS, "home"),
    ).toEqual([]);
  });

  it("rejects an unknown node id", () => {
    // The most likely agent error, and the one that must never reach disk.
    const errors = validateEditOperations(
      [{ op: "text", nodeId: "home.hero.invented", value: "Hi" }], MANIFEST, TOKENS, "home",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/home\.hero\.invented/);
  });

  it("rejects a tombstoned node", () => {
    expect(
      validateEditOperations([{ op: "text", nodeId: "home.hero.gone", value: "Hi" }], MANIFEST, TOKENS, "home"),
    ).toHaveLength(1);
  });

  it("rejects a channel the node does not declare editable", () => {
    // home.hero.headline has no layout channel.
    expect(
      validateEditOperations(
        [{ op: "layout", nodeId: "home.hero.headline", property: "marginTop", value: "16px" }], MANIFEST, TOKENS, "home",
      ),
    ).toHaveLength(1);
  });

  it("rejects a style token that does not exist in this project", () => {
    // The fidelity guarantee, enforced a second time on our side of the wire.
    expect(
      validateEditOperations(
        [{ op: "style", nodeId: "home.hero", property: "background", token: "color.semantic.nope" }], MANIFEST, TOKENS, "home",
      ),
    ).toHaveLength(1);
  });

  it("rejects a node on another route", () => {
    expect(
      validateEditOperations([{ op: "style", nodeId: "shop.grid", property: "background", token: "color.semantic.accent" }], MANIFEST, TOKENS, "home"),
    ).toHaveLength(1);
  });

  it("rejects a sectionOrder that omits a section", () => {
    // Same rule the exporter enforces (7.5): a partial order silently drops a
    // section, and the omission looks like a reorder rather than a deletion.
    expect(
      validateEditOperations([{ op: "sectionOrder", route: "home", order: ["home.hero"] }], MANIFEST, TOKENS, "home"),
    ).toHaveLength(1);
  });

  it("accepts a complete sectionOrder", () => {
    expect(
      validateEditOperations([{ op: "sectionOrder", route: "home", order: ["home.faq", "home.hero"] }], MANIFEST, TOKENS, "home"),
    ).toEqual([]);
  });

  it("reports every problem in one pass, not just the first", () => {
    // The user should see everything wrong at once rather than one per retry.
    expect(
      validateEditOperations(
        [
          { op: "text", nodeId: "home.hero.invented", value: "Hi" },
          { op: "style", nodeId: "home.hero", property: "background", token: "color.semantic.nope" },
        ],
        MANIFEST, TOKENS, "home",
      ),
    ).toHaveLength(2);
  });
});

describe("applyEditOperations", () => {
  it("applies every operation to one map", () => {
    const map = applyEditOperations({}, [
      { op: "text", nodeId: "home.hero.headline", value: "Hi" },
      { op: "style", nodeId: "home.hero", property: "background", token: "color.semantic.accent" },
      { op: "visibility", nodeId: "home.hero", hidden: true },
    ], SECTIONS);

    expect(map["home.hero.headline"]!.text).toBe("Hi");
    expect(map["home.hero"]!.style).toEqual({ background: "color.semantic.accent" });
    expect(map["home.hero"]!.visibility).toBe(true);
  });

  it("keys a sectionOrder operation by the route, as the store does", () => {
    const map = applyEditOperations({}, [{ op: "sectionOrder", route: "home", order: ["home.faq", "home.hero"] }], SECTIONS);
    expect(map.home!.sectionOrder).toEqual(["home.faq", "home.hero"]);
  });

  it("routes an image replace through the text channel with its key", () => {
    const map = applyEditOperations({}, [{ op: "text", nodeId: "home.hero.headline", value: "/img.png", key: "src" }], SECTIONS);
    expect(map["home.hero.headline"]!.text).toEqual({ key: "src", value: "/img.png" });
  });

  it("does not mutate the map it is given", () => {
    const before = {};
    applyEditOperations(before, [{ op: "text", nodeId: "home.hero.headline", value: "Hi" }], SECTIONS);
    expect(before).toEqual({});
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd editor && npx vitest run src/lib/edit-ops.test.ts`
Expected: FAIL — cannot resolve `./edit-ops`

- [ ] **Step 3: Write the implementation**

```typescript
// editor/src/lib/edit-ops.ts
/**
 * Between the edit agent's answer and the override store.
 *
 * Everything here exists because the agent can be wrong: it can name a node
 * that does not exist, reach for a channel an archetype never opened, or invent
 * a token. The requirement is that any of those changes NOTHING — validation is
 * all-or-nothing per prompt, so a compound instruction never half-lands.
 */
import type { Manifest } from "@website-generator/compiler/src/manifest.ts";
import type { EditOperation } from "@website-generator/compiler/src/edit-mock.ts";
import type { OverridesMap } from "./store";
import {
  applyLayoutProperty,
  applyStyleProperty,
  applyTextValue,
  applyVisibility,
} from "./store";

const CHANNEL_OF: Record<EditOperation["op"], string> = {
  text: "text",
  style: "style",
  styleExact: "style",
  layout: "layout",
  visibility: "visibility",
  sectionOrder: "sectionOrder",
};

/** Rejection reasons; empty means the batch may be applied. */
export function validateEditOperations(
  ops: EditOperation[],
  manifest: Manifest,
  tokenPaths: Set<string>,
  route: string,
): string[] {
  const errors: string[] = [];
  const activeSections = Object.entries(manifest.nodes)
    .filter(([id, node]) => node.status === "active" && id.split(".").length === 2 && id.startsWith(`${route}.`))
    .map(([id]) => id);

  for (const op of ops) {
    if (op.op === "sectionOrder") {
      const order = op.order ?? [];
      const missing = activeSections.filter((id) => !order.includes(id));
      if (op.route !== route) errors.push(`reorder names route "${op.route}" but this page is "${route}"`);
      else if (missing.length > 0) errors.push(`reorder omits ${missing.join(", ")}`);
      continue;
    }

    const nodeId = op.nodeId ?? "";
    const node = manifest.nodes[nodeId];
    if (node === undefined || node.status !== "active") {
      errors.push(`"${nodeId}" is not an editable node on this page`);
      continue;
    }
    if (!nodeId.startsWith(`${route}.`) && nodeId !== route) {
      errors.push(`"${nodeId}" is not on route "${route}"`);
      continue;
    }
    const channel = CHANNEL_OF[op.op];
    if (!node.editable.includes(channel)) {
      errors.push(`"${nodeId}" cannot be edited through ${channel}`);
      continue;
    }
    if (op.op === "style" && !tokenPaths.has(op.token ?? "")) {
      errors.push(`"${op.token}" is not a token in this project`);
    }
  }
  return errors;
}

/** Applies a VALIDATED batch. Returns a new map; never mutates the input. */
export function applyEditOperations(
  map: OverridesMap,
  ops: EditOperation[],
  sections: string[],
): OverridesMap {
  let next = { ...map };
  for (const op of ops) {
    switch (op.op) {
      case "text":
        next = applyTextValue(next, op.nodeId!, op.value!, op.key);
        break;
      case "style":
        next = applyStyleProperty(next, op.nodeId!, op.property!, op.token!);
        break;
      case "styleExact":
        next = applyStyleProperty(next, op.nodeId!, op.property!, op.value!);
        break;
      case "layout":
        next = applyLayoutProperty(next, op.nodeId!, op.property!, op.value!);
        break;
      case "visibility":
        next = applyVisibility(next, op.nodeId!, op.hidden === true);
        break;
      case "sectionOrder": {
        // Keyed by the route slug, exactly as moveSection writes it (PRD 3.3).
        const order = (op.order ?? []).filter((id) => sections.includes(id));
        next = { ...next, [op.route!]: { ...next[op.route!], sectionOrder: order } };
        break;
      }
    }
  }
  return next;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd editor && npx vitest run src/lib/edit-ops.test.ts`
Expected: PASS (14 tests)

- [ ] **Step 5: Commit**

```bash
git add editor/src/lib/edit-ops.ts editor/src/lib/edit-ops.test.ts
git commit -m "feat(edit): validate and apply agent operations, all-or-nothing"
```

---

### Task 5: Prompt box and editor wiring

**Files:**
- Create: `editor/src/components/EditPrompt.tsx`
- Modify: `editor/src/App.tsx`
- Modify: `editor/src/App.css`
- Test: `editor/e2e/edit-prompt.spec.ts`

**Interfaces:**
- Consumes: `validateEditOperations`, `applyEditOperations` (Task 4); `POST /__edit-prompt` (Task 3).
- Produces: `data-testid` hooks `edit-prompt-input`, `edit-prompt-submit`, `edit-prompt-summary`, `edit-prompt-clarify`, `edit-prompt-errors`, `edit-prompt-structural`.

- [ ] **Step 1: Write the component**

```tsx
// editor/src/components/EditPrompt.tsx
/**
 * Prompt-driven editing (PRD 4-adjacent; spec 2026-08-03).
 *
 * One box. The agent resolves which nodes are meant, and the result lands
 * immediately with a summary — overrides are free and reversible, so a confirm
 * step on every edit would cost more than a wrong target does.
 */
export type EditPromptState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; notes: string; applied: string[] }
  | { phase: "clarify"; question: string }
  | { phase: "rejected"; errors: string[] }
  | { phase: "structural"; kind: string; reason: string };

export interface EditPromptProps {
  state: EditPromptState;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onUndo: () => void;
}

export default function EditPrompt({ state, value, onChange, onSubmit, onUndo }: EditPromptProps) {
  return (
    <section className="control-section">
      <h3 className="inspector-subheading">Describe a change</h3>
      <textarea
        data-testid="edit-prompt-input"
        className="regen-instruction"
        rows={2}
        placeholder="make the hero headline shorter"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="regen-actions">
        <button
          type="button"
          data-testid="edit-prompt-submit"
          disabled={state.phase === "running" || value.trim() === ""}
          onClick={onSubmit}
        >
          {state.phase === "running" ? "Working…" : "Apply"}
        </button>
      </div>

      {state.phase === "done" && (
        <div data-testid="edit-prompt-summary" className="inspector-note">
          <p>{state.notes}</p>
          <ul>
            {state.applied.map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
          <button type="button" data-testid="edit-prompt-undo" onClick={onUndo}>
            Undo
          </button>
        </div>
      )}
      {state.phase === "clarify" && (
        <p data-testid="edit-prompt-clarify" className="inspector-note">{state.question}</p>
      )}
      {state.phase === "rejected" && (
        <ul data-testid="edit-prompt-errors" className="inspector-note">
          {state.errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      )}
      {state.phase === "structural" && (
        <p data-testid="edit-prompt-structural" className="inspector-note">
          {state.reason} Use the regenerate or add-section controls to do this — it generates new content.
        </p>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Wire it into `App.tsx`**

Add imports:

```tsx
import type { EditPromptState } from "./components/EditPrompt";
import EditPrompt from "./components/EditPrompt";
import { applyEditOperations, validateEditOperations } from "./lib/edit-ops";
```

Add state beside the other `useState` calls:

```tsx
  const [editPrompt, setEditPrompt] = useState<EditPromptState>({ phase: "idle" });
  const [editDraft, setEditDraft] = useState("");
```

Add the handler beside `commitSectionMove`:

```tsx
  /** One prompt = one history entry. Nothing is applied unless every operation
   *  validates, so a compound instruction never half-lands. */
  async function submitEditPrompt() {
    const route = selectedId === undefined ? routes[0]?.slug : routeOf(selectedId);
    if (route === undefined || manifest === null || tokens === null) return;
    const instruction = editDraft;
    setEditPrompt({ phase: "running" });
    try {
      const response = await fetch(`${PREVIEW_URL}/__edit-prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ route, instruction, selection: selectedId }),
      });
      const result = (await response.json()) as {
        operations?: Parameters<typeof validateEditOperations>[0];
        clarify?: string;
        structural?: { kind: string; reason: string };
        notes?: string;
        error?: string;
      };
      if (result.error !== undefined) throw new Error(result.error);
      if (result.structural !== undefined) {
        setEditPrompt({ phase: "structural", kind: result.structural.kind, reason: result.structural.reason });
        return;
      }
      if (result.clarify !== undefined) {
        setEditPrompt({ phase: "clarify", question: result.clarify });
        return;
      }
      const ops = result.operations ?? [];
      const errors = validateEditOperations(ops, manifest, tokenPathSet(tokens), route);
      if (errors.length > 0 || ops.length === 0) {
        setEditPrompt({ phase: "rejected", errors: errors.length > 0 ? errors : ["Nothing to change."] });
        return;
      }
      const sections = renderedSections(geometryByRoute[route] ?? {}, manifest, route);
      setHistory((h) => (h === null ? h : pushHistory(h, applyEditOperations(currentSnapshot(h), ops, sections))));
      setEditDraft("");
      setEditPrompt({
        phase: "done",
        notes: result.notes ?? "",
        applied: ops.map((op) => `${op.op} ${op.nodeId ?? op.route ?? ""}`),
      });
    } catch (error) {
      setEditPrompt({ phase: "rejected", errors: [String(error)] });
    }
  }
```

Render it in the inspector, immediately above `<RegenControls`:

```tsx
          <EditPrompt
            state={editPrompt}
            value={editDraft}
            onChange={setEditDraft}
            onSubmit={() => void submitEditPrompt()}
            onUndo={() => {
              setHistory((h) => (h === null ? h : undo(h)));
              setEditPrompt({ phase: "idle" });
            }}
          />
```

- [ ] **Step 3: Verify it typechecks**

Run: `cd editor && npx tsc --noEmit -p .`
Expected: no errors

- [ ] **Step 4: Write the e2e test**

```typescript
// editor/e2e/edit-prompt.spec.ts
/**
 * Prompt-driven editing against the mock operation source (WG_REGEN_MOCK=1).
 * The model is stubbed; what is under test is the editor's contract — apply,
 * reject, clarify, defer, and one undo entry per prompt.
 */
import { expect, test } from "@playwright/test";
import { openEditor, previewFrameLocator, resetOverrides, waitForSaved } from "./helpers";

test.beforeEach(async ({ page }) => {
  await resetOverrides(page);
  await openEditor(page);
});

async function prompt(page: import("@playwright/test").Page, instruction: string): Promise<void> {
  await page.getByTestId("edit-prompt-input").fill(instruction);
  await page.getByTestId("edit-prompt-submit").click();
}

test("a prompt applies overrides and summarises what changed", async ({ page }) => {
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  await prompt(page, "make the headline shorter");

  await expect(page.getByTestId("edit-prompt-summary")).toBeVisible({ timeout: 20_000 });
  await expect(headline).toHaveText("A shorter headline", { timeout: 15_000 });
  await waitForSaved(page);
});

test("one prompt is one undo entry", async ({ page }) => {
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  const before = (await headline.textContent()) ?? "";
  await prompt(page, "make the headline shorter");
  await expect(headline).toHaveText("A shorter headline", { timeout: 20_000 });

  await page.getByTestId("edit-prompt-undo").click();
  await expect(headline).toHaveText(before, { timeout: 15_000 });
});

test("an invalid operation applies nothing and says why", async ({ page }) => {
  const headline = previewFrameLocator(page).locator('[data-node-id="home.hero.headline"]');
  const before = (await headline.textContent()) ?? "";
  await prompt(page, "INVALID");

  await expect(page.getByTestId("edit-prompt-errors")).toContainText("does-not-exist", { timeout: 20_000 });
  await expect(headline).toHaveText(before);
});

test("an ambiguous prompt asks instead of guessing", async ({ page }) => {
  await prompt(page, "make the button green");
  await expect(page.getByTestId("edit-prompt-clarify")).toContainText(/which button/i, { timeout: 20_000 });
});

test("a structural request defers to the paid flow rather than spending", async ({ page }) => {
  await prompt(page, "add a testimonials section");
  await expect(page.getByTestId("edit-prompt-structural")).toContainText(/generates new content/i, { timeout: 20_000 });
});
```

- [ ] **Step 5: Run the e2e**

Run: `cd editor && npx playwright test e2e/edit-prompt.spec.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add editor/src/components/EditPrompt.tsx editor/src/App.tsx editor/src/App.css editor/e2e/edit-prompt.spec.ts
git commit -m "feat(edit): prompt box, one history entry per prompt"
```

---

### Task 6: Invariant coverage and measured cost

Two things the spec calls non-negotiable: agent-produced overrides must pass the same pixel-diff proof as hand-made ones, and the cost claim must be measured rather than asserted.

**Files:**
- Modify: `editor/e2e/invariant-cases.ts`
- Modify: `docs/decisions.md`

**Interfaces:**
- Consumes: the prompt UI from Task 5.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the invariant case**

In `editor/e2e/invariant-cases.ts`, append to `INVARIANT_CASES` (before the closing `];`):

```typescript
  // ---------- prompt-driven editing ----------
  {
    // An override authored by the agent must survive export exactly as one
    // authored by the canvas does. It compiles through the same channel and the
    // same exporter path, so this SHOULD be redundant — which is precisely why
    // it is worth asserting: if a prompt ever produced something the canvas
    // could not, this is where it would show up as a pixel difference.
    name: "prompt: agent-authored style override on the cta-band heading",
    screenshotNode: "home.cta-band.heading",
    apply: async (page) => {
      await page.getByTestId("edit-prompt-input").fill("make the accent colour change");
      await page.getByTestId("edit-prompt-submit").click();
      await expect(page.getByTestId("edit-prompt-summary")).toBeVisible({ timeout: 20_000 });
    },
  },
```

> **Note for the implementer:** the mock source in Task 3 targets `home.hero.headline` for a colour instruction. Before adding this case, extend `mockEditOperations` so an instruction containing `"accent colour change"` returns a `style` operation on `home.cta-band.heading` with `token: "color.semantic.accent"`, and add a unit test for it in `compiler/src/edit-mock.test.ts`. Keep the existing branches unchanged.

- [ ] **Step 2: Run the invariant suite**

Run: `cd editor && npx playwright test e2e/invariant.spec.ts`
Expected: PASS — the new case pixel-matches between preview and export

- [ ] **Step 3: Measure real cost once, against a live model**

Run, against any generated project (requires `orchestrator/.env` with `ANTHROPIC_API_KEY`):

```bash
uv run --directory orchestrator python -m orchestrator.edit_agent \
  --run-id <an existing run id> --route home \
  --instruction "make the hero headline shorter"
```

Then read the per-role cost from the run log:

```bash
uv run --directory orchestrator python -c "from orchestrator.pricing import cost_for_run; print(cost_for_run('<run id>'))"
```

Record the actual figure. If it differs materially from the spec's ~\$0.001 estimate, **report the measured number** — do not adjust the claim silently.

- [ ] **Step 4: Add the decisions rows**

Append to `docs/decisions.md`:

```
| 2026-08-03 | Prompt-driven editing compiles an instruction to the SAME override operations the canvas produces, rather than regenerating | Regenerating the affected section per prompt | An override is deterministic, free, instantly reversible and preserves preview = handover; a regeneration is ~100x the cost and can rewrite content the user never mentioned. Structural requests are detected and routed to the existing regen/add-section flows behind a cost confirmation, so the capability is not lost -- only the silent spending is | edit-1 |
| 2026-08-03 | The edit agent returns OPERATIONS; the editor applies them | The agent writing override files directly | The ownership map gives override files exactly one writer (contract section 2). Returning operations keeps that true and inherits validation, persistence, undo/redo and export unchanged -- the prompt becomes another way to author the same overrides, not a second kind of edit | edit-1 |
| 2026-08-03 | The `style` operation takes a token path from an enum of the project's own tokens | Accepting a free string and validating afterwards | Makes a raw hex colour unrepresentable rather than merely rejected, which is the same guarantee gate 3 gives generated components. `styleExact` exists for a genuinely explicit "37px" and is counted off-scale in HANDOVER.md exactly as a canvas edit of that kind is | edit-1 |
| 2026-08-03 | Validation is all-or-nothing per prompt | Applying the valid operations and reporting the rest | A compound instruction that half-lands ("made the CTA green but did not hide the badge") is worse than one that cleanly did not, and it keeps "one prompt = one undo entry" honest | edit-1 |
```

- [ ] **Step 5: Full check and commit**

```bash
npm run check
git add editor/e2e/invariant-cases.ts compiler/src/edit-mock.ts compiler/src/edit-mock.test.ts docs/decisions.md
git commit -m "test(edit): invariant coverage for agent-authored overrides; measured cost"
```

---

## Self-Review

**Spec coverage.** Whole-page prompt with agent target resolution → Tasks 1, 2, 5. Override channels only → Task 2 schema, Task 4 validation. Structural detection + cost confirmation → Task 2 (`structural`), Task 5 (`phase: "structural"`). Apply immediately with summary and undo → Task 5. Cached prefix + Haiku with one escalation → Task 2. Token-enum fidelity → Task 2 schema, Task 4 re-check. Off-scale requires explicit intent → `styleExact`. Channel restricted to `editable` → Task 4. All-or-nothing → Task 4, Task 5. Ambiguity asks → Task 2, Task 5. Failure table → Task 5 states. Testing → Tasks 1–6, invariant case in Task 6. Cost measured → Task 6 Step 3.

**Not covered, deliberately:** the spec's "flagged for a human call" (whether the PRD gains a prompt-editing section) is a decision, not an implementation step, and is left in the spec.

**Type consistency.** `EditOperation` and `EditAgentResult` are defined once in `compiler/src/edit-mock.ts` (Task 3) and imported by `editor/src/lib/edit-ops.ts` (Task 4). `validateEditOperations(ops, manifest, tokenPaths, route)` and `applyEditOperations(map, ops, sections)` keep the same signatures in Tasks 4 and 5. The CLI marker `EDIT_RESULT ` matches between Task 2's `main()` and Task 3's `realEditPrompt`. Roles `edit` / `edit-escalated` match between Task 2's `config.py` change and its `resolve_edit` loop.

**Ordering note.** Task 4 imports a type from `compiler/src/edit-mock.ts`, so Task 3 must land first. Tasks 1 → 2 → 3 → 4 → 5 → 6 in order.
