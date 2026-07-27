"""REGEN BLOCK builder: old source, manifest entries, overridden IDs,
user instruction (pipeline 4.1 anatomy, contract 5.3)."""

import json
from pathlib import Path

from orchestrator.section_pipeline import build_regen_block


def scaffold_project(tmp_path: Path) -> Path:
    project = tmp_path / "run"
    sections = project / "src" / "pages" / "home" / "sections"
    mock = project / "src" / "pages" / "home" / "mock"
    overrides = project / "overrides"
    for directory in (sections, mock, overrides):
        directory.mkdir(parents=True)

    (project / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "home.hero": {
                        "route": "/",
                        "file": "src/pages/home/sections/Hero.tsx",
                        "component": "Hero",
                        "element": "section",
                        "editable": ["style"],
                        "status": "active",
                    },
                    "home.hero.headline": {
                        "route": "/",
                        "file": "src/pages/home/sections/Hero.tsx",
                        "component": "Hero",
                        "element": "Heading",
                        "editable": ["text", "style"],
                        "status": "active",
                    },
                    "home.hero.gone": {
                        "route": "/",
                        "file": "src/pages/home/sections/Hero.tsx",
                        "component": "Hero",
                        "element": "Text",
                        "editable": ["text"],
                        "status": "tombstoned",
                    },
                    "home.features.grid": {
                        "route": "/",
                        "file": "src/pages/home/sections/Features.tsx",
                        "component": "Features",
                        "element": "Grid",
                        "editable": ["style"],
                        "status": "active",
                    },
                },
            }
        )
    )
    (overrides / "home.overrides.json").write_text(
        json.dumps(
            {
                "version": 1,
                "route": "/",
                "overrides": [
                    {"nodeId": "home.hero.headline", "channel": "style", "value": {"color": "color.semantic.accent"}},
                    {"nodeId": "home.hero.headline", "channel": "text", "value": "Edited headline"},
                    {"nodeId": "home.features.grid", "channel": "style", "value": {"padding": "space.8"}},
                ],
            }
        )
    )
    (sections / "Hero.tsx").write_text("export default function Hero() { return null; }\n")
    (mock / "Hero.data.ts").write_text("export const heroData = {};\n")
    return project


def test_regen_block_carries_all_four_ingredients(tmp_path: Path) -> None:
    project = scaffold_project(tmp_path)
    block, overridden = build_regen_block(project, "home.hero", "Make the headline playful.")

    assert "Make the headline playful." in block
    assert "home.hero.headline (channels: style, text)" in block
    assert '"home.hero.headline"' in block  # manifest entries as JSON
    assert "export default function Hero()" in block  # old section source
    assert "export const heroData" in block  # old mock source
    assert overridden == ["home.hero.headline"]


def test_regen_block_scopes_to_the_section(tmp_path: Path) -> None:
    project = scaffold_project(tmp_path)
    block, overridden = build_regen_block(project, "home.hero", "x")

    # other sections' overrides and entries stay out
    assert "home.features.grid" not in block
    assert "home.features.grid" not in overridden
    # tombstoned entries are not part of the live section context
    assert '"home.hero.gone"' not in block


def test_regen_block_with_no_overrides_says_none(tmp_path: Path) -> None:
    project = scaffold_project(tmp_path)
    overrides = project / "overrides" / "home.overrides.json"
    overrides.write_text(json.dumps({"version": 1, "route": "/", "overrides": []}))
    block, overridden = build_regen_block(project, "home.hero", "x")
    assert overridden == []
    assert "(none)" in block
