"""`safe_project_path` — the tenth path-traversal defect's chokepoint (M4).

Two halves are tested, and both matter independently: that it REFUSES every
escaping shape (a `..`-only guard would pass the absolute case, which is how
this class of bug keeps shipping), and that it ACCEPTS every path a real
generation actually produces, resolving each to the byte-identical location the
unguarded code used to write to.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from orchestrator.portable import link_directory
from orchestrator.safe_path import UnsafeModelPath, safe_project_path, unsafe_model_paths, unsafe_reason

#: Written as chr(92) so the intent survives any tooling that rewrites escapes.
BACKSLASH = chr(92)

#: Every shape that escapes, with the mechanism each one exploits. Measured
#: against pathlib on this host, not assumed.
ESCAPING = [
    # `Path(root) / x` normalises `..` on the way to the filesystem.
    ("../../evil.ts", "parent traversal"),
    ("src/pages/home/../../../../evil.ts", "traversal after a legitimate prefix"),
    ("..", "the bare parent"),
    (f"..{BACKSLASH}..{BACKSLASH}evil.ts", "traversal spelled with backslashes"),
    (f"src{BACKSLASH}..{BACKSLASH}..{BACKSLASH}evil.ts", "mixed-prefix backslash traversal"),
    # pathlib does not JOIN an absolute right-hand side, it REPLACES: the
    # project root is discarded and no `..` appears anywhere.
    ("/etc/passwd", "POSIX absolute"),
    ("/", "the POSIX root itself"),
    ("C:/Windows/system32/evil.ts", "Windows drive, forward slashes"),
    (f"C:{BACKSLASH}Windows{BACKSLASH}evil.ts", "Windows drive, backslashes"),
    ("C:evil.ts", "Windows DRIVE-RELATIVE (drive but no root — is_absolute() says False)"),
    (f"{BACKSLASH}{BACKSLASH}server{BACKSLASH}share{BACKSLASH}evil.ts", "UNC"),
    ("//server/share/evil.ts", "UNC with forward slashes"),
    (f"{BACKSLASH}etc{BACKSLASH}passwd", "backslash-rooted"),
    # Malformed rather than hostile, but never legitimate output.
    ("", "empty"),
    ("src//evil.ts", "empty path segment"),
    ("src/evil.ts/", "trailing separator"),
    ("src/\x00evil.ts", "NUL byte"),
]

#: Real keys taken from this repo's own run logs — 592 distinct model-authored
#: `files` keys across 911 structured outputs in 15 recorded runs, of which
#: ZERO contained a backslash, a `..`, an absolute prefix or an empty segment.
#: A representative slice is pinned here so the "refuses nothing legitimate"
#: claim is checked by CI and not only by the one-off sweep that established it.
REAL_KEYS = [
    "src/pages/home/sections/Hero.tsx",
    "src/pages/home/mock/Hero.data.ts",
    "src/pages/about/mock/PhilosophyAndApproach.data.ts",
    "src/pages/pricing/sections/PricingTiers.tsx",
    "src/primitives/Button.tsx",
    "src/primitives/Notice.tsx",
    "src/shell/AppShell.tsx",
    "src/shell/Nav.tsx",
    "src/shell/Footer.tsx",
]


@pytest.mark.parametrize("rel_path,mechanism", ESCAPING, ids=[m for _, m in ESCAPING])
def test_refuses_every_escaping_shape(tmp_path: Path, rel_path: str, mechanism: str) -> None:
    with pytest.raises(UnsafeModelPath):
        safe_project_path(tmp_path, rel_path)


def test_refuses_an_absolute_path_that_contains_no_dotdot(tmp_path: Path) -> None:
    """The case a `..`-only guard ships believing it is done.

    Pinned on its own, not just inside the table above, because this is the
    exact reasoning error: `'/etc/passwd'` has no `..` anywhere, yet
    `Path(root) / '/etc/passwd'` is `/etc/passwd` — the root is GONE.
    """
    assert ".." not in "/etc/passwd"
    assert str(tmp_path) not in str(tmp_path / "/etc/passwd")
    with pytest.raises(UnsafeModelPath):
        safe_project_path(tmp_path, "/etc/passwd")


def test_refuses_a_windows_form_on_every_platform(tmp_path: Path) -> None:
    """A guard that only refuses `C:/x` on Windows leaves the container open.

    This product was Windows-only for seven milestones without anyone noticing
    (see `portable.py`), and it now ships in a Linux image — so both flavours
    are checked on both platforms, deliberately, and this test asserts that
    rather than passing vacuously on whichever host ran it.
    """
    assert unsafe_reason("C:/Windows/evil.ts") is not None
    assert unsafe_reason(f"{BACKSLASH}{BACKSLASH}server{BACKSLASH}share{BACKSLASH}x") is not None
    assert unsafe_reason("/etc/passwd") is not None


def test_refuses_a_non_string_key(tmp_path: Path) -> None:
    """Tool-use does not hard-enforce a declared schema (the reason
    `files_of` exists), so a non-string key is reachable, and `Path / 3`
    raises a bare TypeError that names nothing useful."""
    with pytest.raises(UnsafeModelPath):
        safe_project_path(tmp_path, 3)  # type: ignore[arg-type]


def test_refuses_a_symlinked_component_that_leaves_the_tree(tmp_path: Path) -> None:
    """The case no `..` scan can see.

    A generated project genuinely contains a link out of its own tree — its
    `node_modules` is a junction into the fixture — so "no `..`, not absolute"
    is not on its own proof of containment.
    """
    project = tmp_path / "project"
    project.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        link_directory(project / "escape", outside)
    except Exception as error:  # pragma: no cover - platform/privilege dependent
        pytest.skip(f"cannot create a directory link here: {error}")

    assert ".." not in "escape/evil.ts"
    with pytest.raises(UnsafeModelPath):
        safe_project_path(project, "escape/evil.ts")


@pytest.mark.parametrize("rel_path", REAL_KEYS)
def test_accepts_a_real_generated_path_unchanged(tmp_path: Path, rel_path: str) -> None:
    """Acceptance must be behaviour-preserving to the byte.

    The returned path is compared against the raw expression the three write
    sites used BEFORE this helper existed, so a future "improvement" that
    normalises or resolves the result fails here rather than silently moving
    every generated file.
    """
    assert safe_project_path(tmp_path, rel_path) == Path(tmp_path) / rel_path


def test_accepts_every_path_the_fixture_project_contains() -> None:
    """The fixture is the hand-written ground truth every generated project is
    copied from, so any shape it uses is by definition legitimate."""
    fixture = Path(__file__).resolve().parents[2] / "fixtures" / "acme-landing"
    if not fixture.is_dir():  # pragma: no cover - checkout without fixtures
        pytest.skip("fixture project not present")
    skip_dirs = {"node_modules", "dist", ".git", ".regen-backup"}
    checked = 0
    for path in fixture.rglob("*"):
        relative = path.relative_to(fixture)
        if any(part in skip_dirs for part in relative.parts) or not path.is_file():
            continue
        checked += 1
        assert safe_project_path(fixture, relative.as_posix()) == fixture / relative.as_posix()
    assert checked > 20, f"the sweep checked only {checked} files — it is not proving anything"


def test_unsafe_model_paths_reports_every_bad_key_and_no_good_one() -> None:
    """The retry-report half. It must name the offending key: a report saying
    only "bad path" gives the model nothing to correct on the next attempt."""
    issues = unsafe_model_paths(
        {
            "src/pages/home/sections/Hero.tsx": "ok",
            "../../evil.ts": "bad",
            "/etc/passwd": "bad",
        }
    )
    assert len(issues) == 2
    assert any("../../evil.ts" in issue for issue in issues)
    assert any("/etc/passwd" in issue for issue in issues)
    assert not any("Hero.tsx" in issue for issue in issues)


def test_unsafe_model_paths_survives_a_non_mapping() -> None:
    """`files` has arrived as a JSON-encoded STRING from a live run. A report
    builder that raised there would turn a recoverable retry into a crash."""
    assert unsafe_model_paths("not a dict") == []
    assert unsafe_model_paths(None) == []


def test_a_refusal_names_the_path_and_the_root(tmp_path: Path) -> None:
    """The message is the whole value of refusing loudly: a refusal that does
    not say WHICH path or WHERE it tried to go teaches nothing."""
    with pytest.raises(UnsafeModelPath) as caught:
        safe_project_path(tmp_path, "../../evil.ts")
    message = str(caught.value)
    assert "../../evil.ts" in message
    assert str(tmp_path) in message


# ---------- the three write sites the defect actually shipped in ----------


def test_the_section_write_funnel_refuses_and_writes_NOTHING(tmp_path: Path) -> None:
    """The funnel resolves every key before writing any of them.

    Refusing partway through a mapping would leave the section half-written —
    some files from this attempt, some from the last — which is precisely the
    state contract 5.3's "a section rewrite fully replaces its own files"
    exists to prevent.
    """
    from orchestrator.section_pipeline import write_files_repairing_images

    project = tmp_path / "project"
    project.mkdir()
    with pytest.raises(UnsafeModelPath):
        write_files_repairing_images(
            str(project),
            {
                "src/pages/home/sections/Hero.tsx": "export default function Hero() { return null; }\n",
                "../../evil.ts": "pwned\n",
            },
        )
    assert not (project / "src").exists(), "a good file was written before the bad key was refused"
    assert not (tmp_path.parent / "evil.ts").exists()


def test_the_section_retry_loop_is_handed_a_failure_report() -> None:
    """A bad path must cost ONE retry, not the whole run.

    By the time a section is generated the run has already paid for intake,
    planning, tokens, primitives and the shell; killing it over an output shape
    the model could fix on the next attempt is the wrong trade. The raise in
    the funnel is the backstop behind this, not the primary path.
    """
    from orchestrator.section_pipeline import validate_file_paths

    report = validate_file_paths({"../../evil.ts": "x", "/etc/passwd": "y"})
    assert report, "an escaping path produced no failure report — the model gets no chance to fix it"
    assert "../../evil.ts" in report and "/etc/passwd" in report
    assert validate_file_paths({"src/pages/home/sections/Hero.tsx": "x"}) == ""


def test_write_primitives_refuses_BEFORE_deleting_the_primitives(tmp_path: Path) -> None:
    """`write_primitives` rmtree's src/primitives/ before writing.

    If the refusal came from the write loop instead, a bad key would leave the
    project with NO primitives — every page imports from there — and the retry
    would be generating against a project it had just destroyed.
    """
    from orchestrator import design_pipeline

    project = tmp_path / "project"
    (project / "src" / "primitives").mkdir(parents=True)
    (project / "src" / "primitives" / "Button.tsx").write_text("export default 1;\n", encoding="utf-8")

    result = design_pipeline.write_primitives.__wrapped__(
        str(project), {"files": {"/etc/passwd": "pwned"}, "inventory": []}, 1
    )
    assert result["ok"] is False
    assert any("/etc/passwd" in issue for issue in result["issues"])
    assert (project / "src" / "primitives" / "Button.tsx").exists(), "the primitives were deleted anyway"


def test_write_shell_refuses_BEFORE_deleting_the_shell(tmp_path: Path) -> None:
    """Same shape as write_primitives, for the one directory every page imports."""
    from orchestrator import shell_pipeline

    project = tmp_path / "project"
    (project / "src" / "shell").mkdir(parents=True)
    (project / "src" / "shell" / "Nav.tsx").write_text("export default 1;\n", encoding="utf-8")

    result = shell_pipeline.write_shell.__wrapped__(
        str(project),
        "export const routes = [];\n",
        {"files": {"../../evil.ts": "pwned"}},
        1,
    )
    assert result["ok"] is False
    assert any("../../evil.ts" in issue for issue in result["issues"])
    assert (project / "src" / "shell" / "Nav.tsx").exists(), "the shell was deleted anyway"


def test_replace_section_files_refuses_a_traversing_key(tmp_path: Path) -> None:
    """`files.py` takes a `files` mapping exactly like the three sites that
    shipped the defect; its current caller passing a literal is not a property
    of the function."""
    from orchestrator.files import replace_section_files

    section = tmp_path / "project" / "section"
    with pytest.raises(UnsafeModelPath):
        replace_section_files(str(section), {"../../../evil.ts": "pwned"})
    assert not (tmp_path / "evil.ts").exists()


def test_nothing_is_written_when_a_path_is_refused(tmp_path: Path) -> None:
    """`mkdir(parents=True)` at the call sites CREATES the chain a bad path
    names, so refusing after the directory exists would still have left a
    footprint outside the project."""
    project = tmp_path / "project"
    project.mkdir()
    with pytest.raises(UnsafeModelPath):
        safe_project_path(project, "../../../escaped/evil.ts")
    assert not (tmp_path.parent / "escaped").exists()
    assert list(project.iterdir()) == []
