"""File-write step: fully replaces a section's files (pipeline 5.3 idempotence)."""

from pathlib import Path

from orchestrator.files import replace_section_files


def test_writes_files_into_a_fresh_directory(tmp_path: Path) -> None:
    target = tmp_path / "section"
    written = replace_section_files(str(target), {"Hero.tsx": "export {}\n", "mock/Hero.data.ts": "x\n"})
    assert written == ["Hero.tsx", "mock/Hero.data.ts"]
    assert (target / "Hero.tsx").read_text() == "export {}\n"
    assert (target / "mock" / "Hero.data.ts").read_text() == "x\n"


def test_fully_replaces_stale_content(tmp_path: Path) -> None:
    target = tmp_path / "section"
    target.mkdir()
    (target / "Stale.tsx").write_text("old")

    replace_section_files(str(target), {"Hero.tsx": "new\n"})

    assert not (target / "Stale.tsx").exists()
    assert (target / "Hero.tsx").read_text() == "new\n"


def test_replaying_a_half_written_section_is_safe(tmp_path: Path) -> None:
    """A crashed write replayed from scratch must converge to the same tree."""
    target = tmp_path / "section"
    files = {"Hero.tsx": "a\n", "mock/Hero.data.ts": "b\n"}

    # simulate a half-written state, then the full replayed write
    target.mkdir()
    (target / "Hero.tsx").write_text("torn write")
    first = replace_section_files(str(target), files)
    second = replace_section_files(str(target), files)

    assert first == second
    assert (target / "Hero.tsx").read_text() == "a\n"
    assert sorted(p.name for p in target.rglob("*") if p.is_file()) == ["Hero.data.ts", "Hero.tsx"]
