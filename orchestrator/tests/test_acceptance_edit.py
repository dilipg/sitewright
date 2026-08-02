"""The end-to-end editing loop's harness logic.

`check_overrides_survived` is the assertion the whole live run rests on, so it
gets tested hardest: if it is wrong in the permissive direction, a run that
silently dropped edits reports success, and the run proves nothing.
"""

import json
from pathlib import Path

import pytest

from orchestrator.acceptance import StageError
from orchestrator.acceptance_edit import (
    check_overrides_survived,
    pick_route,
    seed_overrides,
)


def node(element: str, editable: list[str], *, route: str = "/", status: str = "active") -> dict:
    return {
        "route": route,
        "file": "src/pages/home/sections/X.tsx",
        "component": "X",
        "element": element,
        "editable": editable,
        "status": status,
    }


FULL = ["text", "style", "layout", "visibility"]


def project(tmp_path: Path, nodes: dict) -> Path:
    directory = tmp_path / "run"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "manifest.json").write_text(
        json.dumps({"version": 1, "nodes": nodes}), encoding="utf-8"
    )
    return directory


def typical_site(tmp_path: Path) -> Path:
    return project(
        tmp_path,
        {
            "home.hero": node("section", ["style", "layout", "visibility"]),
            "home.hero.headline": node("Heading", FULL),
            "home.hero.subheadline": node("Text", FULL),
            "home.hero.badge": node("Badge", FULL),
            "home.faq": node("section", ["style", "layout", "visibility"]),
            "home.faq.heading": node("Heading", FULL),
            "about.intro": node("section", ["style"], route="/about"),
        },
    )


# ---------- route selection ----------


def test_the_route_with_the_most_sections_is_chosen(tmp_path: Path) -> None:
    """More sections means more for a page regen to get wrong."""
    assert pick_route(typical_site(tmp_path)) == "home"


def test_a_project_with_no_active_nodes_fails_loudly(tmp_path: Path) -> None:
    directory = project(tmp_path, {"home.hero": node("section", ["style"], status="tombstoned")})
    with pytest.raises(StageError, match="no active"):
        pick_route(directory)


# ---------- seeding ----------


def test_seeding_covers_every_channel_on_distinct_nodes(tmp_path: Path) -> None:
    """Spread across nodes on purpose: several channels on one node would prove
    one id survived, when what matters is a page's worth of edits surviving."""
    directory = typical_site(tmp_path)
    (directory / "overrides").mkdir()
    entries = seed_overrides(directory, "home")

    channels = [entry["channel"] for entry in entries]
    assert set(channels) == {"style", "text", "layout", "visibility", "sectionOrder"}
    assert len(channels) == len(set(channels)), "one override per channel"
    node_ids = [entry["nodeId"] for entry in entries if entry["channel"] != "sectionOrder"]
    assert len(node_ids) == len(set(node_ids)), "channels must land on distinct nodes"


def test_seeding_only_uses_nodes_that_declare_the_channel(tmp_path: Path) -> None:
    """The manifest's own `editable` list decides — an override on a channel a
    node does not declare is rejected at export, so guessing would fail late."""
    directory = project(
        tmp_path,
        {
            "home.hero": node("section", ["style"]),
            "home.hero.headline": node("Heading", ["text"]),  # no layout, no visibility
        },
    )
    (directory / "overrides").mkdir()
    entries = seed_overrides(directory, "home")
    assert {entry["channel"] for entry in entries} == {"style", "text"}


def test_the_seeded_reorder_names_every_section_on_the_route(tmp_path: Path) -> None:
    """A partial order is a hard export failure by design (7.5): an omitted
    section would silently vanish from the page rather than merely stay put."""
    directory = typical_site(tmp_path)
    (directory / "overrides").mkdir()
    entries = seed_overrides(directory, "home")
    order = next(entry for entry in entries if entry["channel"] == "sectionOrder")
    assert order["nodeId"] == "home", "sectionOrder is keyed by the route slug"
    assert sorted(order["value"]) == ["home.faq", "home.hero"]
    assert order["value"] != ["home.hero", "home.faq"], "must actually reorder something"


def test_a_single_section_route_gets_no_reorder(tmp_path: Path) -> None:
    directory = project(tmp_path, {"home.hero": node("section", ["style"])})
    (directory / "overrides").mkdir()
    entries = seed_overrides(directory, "home")
    assert all(entry["channel"] != "sectionOrder" for entry in entries)


def test_the_written_file_is_shaped_like_the_editors_own(tmp_path: Path) -> None:
    directory = typical_site(tmp_path)
    (directory / "overrides").mkdir()
    seed_overrides(directory, "home")
    written = json.loads((directory / "overrides" / "home.overrides.json").read_text(encoding="utf-8"))
    assert written["version"] == 1
    assert written["route"] == "/", "the route PATH, not the slug (contract 6.1)"
    assert all("updatedAt" in entry for entry in written["overrides"])


# ---------- the load-bearing assertion ----------


def test_an_override_whose_node_survives_and_is_kept_passes(tmp_path: Path) -> None:
    directory = typical_site(tmp_path)
    entries = [{"nodeId": "home.hero.headline", "channel": "text", "value": "x"}]
    result = check_overrides_survived(directory, entries, {"orphanedOverrides": []}, "step")
    assert result["orphaned"] == []
    assert result["survived"] == ["home.hero.headline"]


def test_a_node_removed_AND_declared_orphaned_is_reported_not_failed(tmp_path: Path) -> None:
    """An orphan is a correct outcome (PRD 4.3): the model legitimately dropped
    the element and the run said so. Failing here would fail correct behaviour."""
    directory = typical_site(tmp_path)
    entries = [{"nodeId": "home.hero.gone", "channel": "text", "value": "x"}]
    result = check_overrides_survived(
        directory, entries, {"orphanedOverrides": ["home.hero.gone"]}, "step"
    )
    assert result["orphaned"] == ["home.hero.gone"]


def test_a_node_removed_WITHOUT_being_declared_is_a_hard_failure(tmp_path: Path) -> None:
    """The silent drop the whole architecture exists to prevent: the override's
    target is gone and nothing told the user."""
    directory = typical_site(tmp_path)
    entries = [{"nodeId": "home.hero.gone", "channel": "text", "value": "x"}]
    with pytest.raises(StageError, match="lost without being declared"):
        check_overrides_survived(directory, entries, {"orphanedOverrides": []}, "step")


def test_a_surviving_node_reported_as_orphaned_is_also_a_hard_failure(tmp_path: Path) -> None:
    """The inverse inconsistency: the node is still registered and editable, yet
    the run claims its override has no target. Either the report or the manifest
    is wrong, and both matter too much to wave through."""
    directory = typical_site(tmp_path)
    entries = [{"nodeId": "home.hero.headline", "channel": "text", "value": "x"}]
    with pytest.raises(StageError, match="lost without being declared"):
        check_overrides_survived(
            directory, entries, {"orphanedOverrides": ["home.hero.headline"]}, "step"
        )


def test_the_reorder_override_is_exempt_from_the_node_check(tmp_path: Path) -> None:
    """Its nodeId is a route slug, so looking it up in the manifest would always
    fail and report every run as having lost an override."""
    directory = typical_site(tmp_path)
    entries = [{"nodeId": "home", "channel": "sectionOrder", "value": ["home.faq", "home.hero"]}]
    result = check_overrides_survived(directory, entries, {"orphanedOverrides": []}, "step")
    assert result["orphaned"] == []
