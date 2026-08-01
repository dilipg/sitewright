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


# ---------- exec-id targeting (milestone 7.1) ----------


def _log(tmp_path: Path, events: list[dict]) -> Path:
    log = tmp_path / "run.jsonl"
    log.write_text("\n".join(json.dumps(e) for e in events) + "\n", encoding="utf-8")
    return log


def _generated(section: str, exec_id: str) -> dict:
    return {
        "event_type": "section.generated",
        "section": section,
        "checkpoint_ref": f"{exec_id}/generate_section#a1",
    }


def test_recorded_exec_id_picks_the_requested_sections_own_execution(tmp_path, monkeypatch) -> None:
    """Every section of a run shares one run_id and one log, so the LAST
    generated event is whichever section finished last -- not necessarily the
    one being regenerated. Taking it outright meant regenerating section X
    replayed section Y's execution (observed live: regenerating
    shop.product-grid replayed home.cta-band, leaving shop untouched and
    colliding ids on home)."""
    from orchestrator import regenerate

    log = _log(
        tmp_path,
        [
            _generated("shop.product-grid", "exec-shop"),
            _generated("home.cta-band", "exec-home"),  # finished last
        ],
    )
    monkeypatch.setattr(regenerate, "default_run_log_path", lambda run_id: log)

    assert regenerate.recorded_exec_id("run", "shop.product-grid") == "exec-shop"
    assert regenerate.recorded_exec_id("run", "home.cta-band") == "exec-home"


def test_recorded_exec_id_uses_the_latest_execution_of_that_section(tmp_path, monkeypatch) -> None:
    """A section regenerated twice has several executions; the newest is the
    one whose output is currently on disk."""
    from orchestrator import regenerate

    log = _log(
        tmp_path,
        [
            _generated("shop.product-grid", "exec-old"),
            _generated("home.hero", "exec-other"),
            _generated("shop.product-grid", "exec-new"),
        ],
    )
    monkeypatch.setattr(regenerate, "default_run_log_path", lambda run_id: log)
    assert regenerate.recorded_exec_id("run", "shop.product-grid") == "exec-new"


def test_recorded_exec_id_names_what_the_run_does_contain_when_asked_for_an_unknown_section(
    tmp_path, monkeypatch
) -> None:
    """Failing loudly with the real section list beats replaying an unrelated
    execution, which is what the old behaviour did silently."""
    import pytest

    from orchestrator import regenerate

    log = _log(tmp_path, [_generated("home.hero", "exec-a"), _generated("shop.grid", "exec-b")])
    monkeypatch.setattr(regenerate, "default_run_log_path", lambda run_id: log)

    with pytest.raises(SystemExit) as excinfo:
        regenerate.recorded_exec_id("run", "cart.cart-drawer")
    message = str(excinfo.value)
    assert "cart.cart-drawer" in message
    assert "home.hero" in message and "shop.grid" in message
