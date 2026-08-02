"""REGEN BLOCK builder: old source, manifest entries, overridden IDs,
user instruction (pipeline 4.1 anatomy, contract 5.3)."""

import json
from pathlib import Path

import pytest

from orchestrator import regenerate
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


# ---------- page-level regeneration (7.9, PRD section 4) ----------


def _manifest_project(tmp_path: Path, nodes: dict) -> Path:
    project = tmp_path / "run"
    project.mkdir(parents=True, exist_ok=True)
    (project / "manifest.json").write_text(
        json.dumps({"version": 1, "nodes": nodes}), encoding="utf-8"
    )
    return project


def _section_node(status: str = "active") -> dict:
    return {
        "route": "/",
        "file": "src/pages/home/sections/X.tsx",
        "component": "X",
        "element": "section",
        "editable": ["style"],
        "status": status,
    }


def test_route_sections_returns_only_that_routes_active_section_roots(tmp_path: Path) -> None:
    project = _manifest_project(
        tmp_path,
        {
            "home.hero": _section_node(),
            "home.hero.headline": _section_node(),  # a child, not a section root
            "home.retired": _section_node("tombstoned"),
            "home.faq": _section_node(),
            "shop.grid": _section_node(),  # another route
        },
    )
    assert regenerate.route_sections(project, "home") == ["home.hero", "home.faq"]


def test_route_sections_keeps_registration_order(tmp_path: Path) -> None:
    """Registration order is the order the page worker generated the sections,
    which is the order they were assembled into index.tsx -- so a page regen
    walks the page top to bottom rather than alphabetically."""
    project = _manifest_project(
        tmp_path,
        {"home.zebra": _section_node(), "home.alpha": _section_node()},
    )
    assert regenerate.route_sections(project, "home") == ["home.zebra", "home.alpha"]


def test_page_regen_forks_each_section_separately(tmp_path, monkeypatch) -> None:
    """7.1's constraint: there is no page-level execution to replay. A page
    regen is N section forks, each replaying its OWN recorded execution."""
    project = _manifest_project(
        tmp_path, {"home.hero": _section_node(), "home.faq": _section_node()}
    )
    monkeypatch.setattr(regenerate, "GENERATED_DIR", project.parent)
    calls: list[tuple[str, str]] = []

    def fake_section(run_id: str, section: str, instruction: str) -> dict:
        calls.append((section, instruction))
        return _section_result()

    monkeypatch.setattr(regenerate, "regenerate_section", fake_section)
    result = regenerate.regenerate_page("run", "home", "warmer tone")

    assert calls == [("home.hero", "warmer tone"), ("home.faq", "warmer tone")]
    assert result["sections"] == ["home.hero", "home.faq"]
    assert result["passed"] is True


def _section_result(
    *,
    passed: bool = True,
    orphans: list[str] | None = None,
    tombstoned: list[str] | None = None,
    overridden: list[str] | None = None,
    attempts: int = 1,
    gate7: int = 0,
    report: str = "",
) -> dict:
    return {
        "passed": passed,
        "attempts": attempts,
        "orphanedOverrides": orphans or [],
        "overriddenIds": overridden or [],
        "tombstoned": tombstoned or [],
        "gate7Retries": gate7,
        "failureReport": report,
    }


def test_orphans_are_merged_so_the_page_asks_once_not_once_per_section(
    tmp_path, monkeypatch
) -> None:
    """PRD 4.3's orphan dialog is a decision point; asking it once per section
    would turn one decision into a wall of prompts."""
    project = _manifest_project(
        tmp_path,
        {"home.hero": _section_node(), "home.faq": _section_node(), "home.cta": _section_node()},
    )
    monkeypatch.setattr(regenerate, "GENERATED_DIR", project.parent)
    results = {
        "home.hero": _section_result(orphans=["home.hero.badge"], tombstoned=["home.hero.badge"]),
        "home.faq": _section_result(),
        "home.cta": _section_result(orphans=["home.cta.note"], tombstoned=["home.cta.note"]),
    }
    monkeypatch.setattr(
        regenerate, "regenerate_section", lambda run_id, section, instruction: results[section]
    )
    result = regenerate.regenerate_page("run", "home", "tighten the copy")

    assert result["orphanedOverrides"] == ["home.cta.note", "home.hero.badge"]
    assert result["tombstoned"] == ["home.cta.note", "home.hero.badge"]


def test_one_failed_section_fails_the_page_and_names_which(tmp_path, monkeypatch) -> None:
    """The same rule as the DAG report: a failure must stay visible at the
    level above rather than being averaged away by passing siblings."""
    project = _manifest_project(
        tmp_path, {"home.hero": _section_node(), "home.faq": _section_node()}
    )
    monkeypatch.setattr(regenerate, "GENERATED_DIR", project.parent)
    results = {
        "home.hero": _section_result(),
        "home.faq": _section_result(passed=False, report="gate 3: raw hex", attempts=3, gate7=1),
    }
    monkeypatch.setattr(
        regenerate, "regenerate_section", lambda run_id, section, instruction: results[section]
    )
    result = regenerate.regenerate_page("run", "home", "tighten the copy")

    assert result["passed"] is False
    assert result["failureReport"] == "home.faq: gate 3: raw hex"
    assert "home.hero" not in result["failureReport"]
    assert result["perSection"] == {"home.hero": True, "home.faq": False}
    assert result["attempts"] == 4  # rolled up across the page
    assert result["gate7Retries"] == 1


def test_a_route_with_no_active_sections_fails_loudly(tmp_path, monkeypatch) -> None:
    project = _manifest_project(tmp_path, {"home.hero": _section_node("tombstoned")})
    monkeypatch.setattr(regenerate, "GENERATED_DIR", project.parent)
    with pytest.raises(SystemExit, match="no active sections on route 'home'"):
        regenerate.regenerate_page("run", "home", "anything")
