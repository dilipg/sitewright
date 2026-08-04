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

from orchestrator.config import ORCHESTRATOR_ROOT

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


def style_properties() -> list[str]:
    """Every property a style/layout operation may name.

    Read from the COMPILER's own list rather than restated here. The exporter
    compiles each property to a Tailwind utility and throws on anything it has
    no mapping for, while the preview shim applies any CSS property at all — so
    a property this list does not contain renders in the preview, persists, and
    then kills the export. That is the preview-≠-handover failure the whole
    architecture exists to prevent, which is why the list is data both
    languages read (compiler/src/style-properties.json) and not a copy.
    """
    path = ORCHESTRATOR_ROOT.parent / "compiler" / "src" / "style-properties.json"
    return list(json.loads(path.read_text(encoding="utf-8")).keys())


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
