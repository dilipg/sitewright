"""The acceptance runner's reporting. The chaining itself is exercised by real
runs; what is unit-testable — and what a real run showed mattering — is whether
the summary tells the truth about a degraded page."""

import json
from pathlib import Path

from orchestrator.acceptance import degraded_sections


def project(tmp_path: Path, planned: dict[str, list[str]], built: list[str]) -> Path:
    directory = tmp_path / "run"
    (directory / "plan").mkdir(parents=True)
    (directory / "plan" / "siteplan.json").write_text(
        json.dumps(
            {
                "routes": [
                    {"slug": slug, "sections": [{"slug": s} for s in sections]}
                    for slug, sections in planned.items()
                ]
            }
        ),
        encoding="utf-8",
    )
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {node_id: {"status": "active"} for node_id in built},
            }
        ),
        encoding="utf-8",
    )
    return directory


def test_a_fully_built_site_reports_nothing_degraded(tmp_path: Path) -> None:
    directory = project(
        tmp_path, {"home": ["hero", "faq"]}, ["home.hero", "home.faq", "home.hero.headline"]
    )
    assert degraded_sections(directory) == []


def test_a_section_that_exhausted_its_retries_is_named(tmp_path: Path) -> None:
    """The real case this was written for: a run exited 0, exported cleanly and
    reported success while one page shipped a FailedSectionPlaceholder where its
    data grid should have been. Degrading is correct (pipeline 5.4); reporting
    success without saying so is not."""
    directory = project(tmp_path, {"submissions": ["toolbar", "grid"]}, ["submissions.toolbar"])
    assert degraded_sections(directory) == ["submissions.grid"]


def test_a_tombstoned_section_counts_as_degraded(tmp_path: Path) -> None:
    directory = project(tmp_path, {"home": ["hero"]}, [])
    directory_manifest = directory / "manifest.json"
    directory_manifest.write_text(
        json.dumps({"version": 1, "nodes": {"home.hero": {"status": "tombstoned"}}}),
        encoding="utf-8",
    )
    assert degraded_sections(directory) == ["home.hero"]


def test_child_nodes_never_stand_in_for_their_section(tmp_path: Path) -> None:
    """A section root is a two-segment id; counting any node under the route
    would let a surviving child mask the fact that its section never built."""
    directory = project(tmp_path, {"home": ["hero"]}, ["home.hero.headline"])
    assert degraded_sections(directory) == ["home.hero"]


def test_a_project_with_no_plan_reports_nothing_rather_than_crashing(tmp_path: Path) -> None:
    directory = tmp_path / "empty"
    directory.mkdir()
    assert degraded_sections(directory) == []
