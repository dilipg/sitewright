"""Fixture-backed agent context — the M3/M4 stub (build-plan stubbing table):
page agents generate against the hand-written fixture's tokens, primitives,
and shell until the Design System and Shell agents replace them in M5."""

import json
from pathlib import Path

from orchestrator.config import ORCHESTRATOR_ROOT

REPO_ROOT = ORCHESTRATOR_ROOT.parent
FIXTURE_DIR = REPO_ROOT / "fixtures" / "acme-landing"


def fixture_tokens() -> dict:
    return json.loads(
        (FIXTURE_DIR / "src" / "tokens" / "tokens.json").read_text(encoding="utf-8")
    )


def fixture_primitive_signatures() -> list[str]:
    """Signature lines for the fixture's four primitives. In M5 the Design
    System Agent emits this inventory as structured output."""
    return [
        'Button({ nodeId?, variant?: "primary" | "secondary", href?, className?, children })'
        " — renders <a> when href is set; href must be in the route table or external",
        'Heading({ nodeId?, level?: 1 | 2 | 3, variant?: "display" | "section" | "subsection", className?, children })',
        'Text({ nodeId?, variant?: "body" | "lead" | "eyebrow", className?, children })',
        "Container({ nodeId?, className?, children }) — centered max-width content wrapper",
    ]


def fixture_route_table() -> str:
    return json.dumps([{"slug": "home", "path": "/", "title": "Home"}])
