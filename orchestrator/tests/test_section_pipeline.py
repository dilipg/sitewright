"""Pure parts of the single-section pipeline: workspace prep, deterministic
index assembly, failure-report formatting, retry-prompt construction."""

import json
from pathlib import Path

from orchestrator.section_pipeline import (
    build_index_source,
    format_gate_failures,
    prepare_workspace_dir,
    user_prompt_with_failures,
)


def test_prepare_workspace_copies_fixture_with_a_blank_page(tmp_path: Path) -> None:
    project = tmp_path / "run-x"
    prepare_workspace_dir(str(project))

    # fixture spine intact (stub table: tokens/primitives/shell stay hand-written)
    assert (project / "src" / "tokens" / "tokens.json").exists()
    assert (project / "src" / "primitives" / "Button.tsx").exists()
    assert (project / "src" / "shell" / "routes.ts").exists()
    assert (project / "package.json").exists()
    assert not (project / "node_modules").exists()

    # the page is blank: no fixture hero, empty manifest, empty overrides
    assert not (project / "src" / "pages" / "home" / "sections").exists()
    manifest = json.loads((project / "manifest.json").read_text())
    assert manifest == {"version": 1, "nodes": {}}
    overrides = json.loads((project / "overrides" / "home.overrides.json").read_text())
    assert overrides["overrides"] == []


def test_prepare_workspace_fully_replaces_a_stale_dir(tmp_path: Path) -> None:
    project = tmp_path / "run-x"
    project.mkdir(parents=True)
    (project / "stale.txt").write_text("old")
    prepare_workspace_dir(str(project))
    assert not (project / "stale.txt").exists()


def test_build_index_source_assembles_the_section() -> None:
    source = build_index_source(
        route_slug="home",
        section_slug="hero",
        component="Hero",
    )
    assert 'import Hero from "./sections/Hero";' in source
    assert 'import { heroData } from "./mock/Hero.data";' in source
    assert '<Hero nodeId="home.hero" {...heroData} />' in source


def test_format_gate_failures_is_actionable_and_names_the_attempt() -> None:
    report = {
        "passed": False,
        "gates": [
            {"gate": 3, "name": "tokens-only", "passed": False, "failures": [
                {"gate": 3, "reason": "raw-hex", "message": 'Raw hex color "#ff0000" at src/pages/home/sections/Hero.tsx:12.'}
            ]},
            {"gate": 5, "name": "content-via-props", "passed": True, "failures": []},
        ],
    }
    text = format_gate_failures(report)
    assert 'Raw hex color "#ff0000"' in text
    assert "gate 3" in text


def test_user_prompt_with_failures_appends_the_report_block() -> None:
    base = "[PAGE CONTEXT]\n..."
    with_failures = user_prompt_with_failures(base, "gate 3: Raw hex color ...")
    assert with_failures.startswith(base)
    assert "PREVIOUS ATTEMPT FAILED VALIDATION" in with_failures
    assert "gate 3: Raw hex color" in with_failures
    # first attempt: unchanged
    assert user_prompt_with_failures(base, "") == base
