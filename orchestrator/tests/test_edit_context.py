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
