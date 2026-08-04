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

from orchestrator.edit_context import build_route_projection, style_properties, token_vocabulary
from orchestrator.model_call import call_model_structured_impl
from orchestrator.section_pipeline import GENERATED_DIR

MAX_TOKENS = 2000

_STRUCTURAL_KINDS = ["add-section", "regenerate-section", "regenerate-page"]


def build_tool_schema(tokens: list[str], properties: list[str] | None = None) -> dict:
    """The operation set, with `style` restricted to THIS project's tokens.

    The enum is the fidelity guarantee: a raw colour is not merely discouraged,
    it is unrepresentable. `styleExact` exists so an explicit "exactly 37px" is
    still possible, and the exporter counts it as off-scale exactly as it counts
    a canvas edit of the same kind.

    `property` is enumerated for the same reason, from the compiler's own list
    (see `style_properties`): it was an open string, so the model could ask for
    `fontFamily` or `opacity`, which validated, rendered in the preview, and
    then hard-failed the export — the one failure mode the architecture exists
    to prevent. Unrepresentable beats rejected-afterwards.
    """
    node = {"type": "string", "description": "a nodeId from the projection"}
    prop = {
        "type": "string",
        "enum": style_properties() if properties is None else properties,
        "description": "a css property the exporter can compile",
    }
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
                                "property": prop,
                                "token": {"type": "string", "enum": tokens},
                            },
                            "required": ["op", "nodeId", "property", "token"],
                        },
                        {
                            "type": "object",
                            "properties": {
                                "op": {"const": "styleExact"},
                                "nodeId": node,
                                "property": prop,
                                "value": {"type": "string"},
                            },
                            "required": ["op", "nodeId", "property", "value"],
                        },
                        {
                            "type": "object",
                            "properties": {
                                "op": {"const": "layout"},
                                "nodeId": node,
                                "property": prop,
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
        "clarify": "I could not work out what to change. Try naming the element, e.g. \"make the hero headline shorter\".",
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
