"""Checkpointed file writes. A section write FULLY REPLACES the section's
directory (pipeline 5.3): replaying a step that half-wrote is safe because
the write never appends — it converges to the same tree every time."""

import shutil
from pathlib import Path

from kitaru import checkpoint


def replace_section_files(section_dir: str, files: dict[str, str]) -> list[str]:
    base = Path(section_dir)
    if base.exists():
        shutil.rmtree(base)
    base.mkdir(parents=True, exist_ok=True)
    for relative_path in sorted(files):
        target = base / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(files[relative_path], encoding="utf-8", newline="\n")
    return sorted(files)


write_section_files = checkpoint(replace_section_files)
