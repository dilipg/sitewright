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
