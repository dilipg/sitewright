"""Checkpointed file writes. A section write FULLY REPLACES the section's
directory (pipeline 5.3): replaying a step that half-wrote is safe because
the write never appends — it converges to the same tree every time."""

import shutil
from pathlib import Path

from kitaru import checkpoint

from orchestrator.safe_path import safe_project_path


def replace_section_files(section_dir: str, files: dict[str, str]) -> list[str]:
    base = Path(section_dir)
    if base.exists():
        shutil.rmtree(base)
    base.mkdir(parents=True, exist_ok=True)
    for relative_path in sorted(files):
        # Today's only production caller (`demo.py`) passes a literal filename,
        # but this signature takes a `files` mapping exactly like the three
        # sites that DID ship the traversal, so it goes through the same funnel
        # rather than being argued safe by its current caller (task M4).
        target = safe_project_path(base, relative_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(files[relative_path], encoding="utf-8", newline="\n")
    return sorted(files)


write_section_files = checkpoint(replace_section_files)
