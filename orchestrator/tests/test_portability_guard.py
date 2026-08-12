"""No module may reintroduce a Windows-only spawn.

WHY THIS EXISTS: the product was Windows-only for its entire life and nobody
noticed until a Docker image was built. Seven spawn sites hardcoded
``["cmd", "/c", ...]`` or ``shell=True`` with a list, and the consequences were
not cosmetic:

* ``design_pipeline.write_primitives`` is a ``@checkpoint``, so on Linux a run
  died **after partial spend**.
* ``fanout.spawn_worker`` passed a LIST with ``shell=True``. On POSIX that hands
  ``sh -c`` only ``argv[0]``, so every page worker would have run a bare ``uv``
  and no site would have had any sections — and that site was found only after
  the other six were fixed, because fixing six of seven still produced nothing.

Spot-fixing is what let this survive seven milestones. This guard is the part
that stops it coming back: a reviewer cannot be relied on to notice the eighth.

``portable.py`` is the ONE module allowed to name ``cmd``/``mklink``, because
branching on the platform is precisely its job.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "orchestrator"

#: The only module permitted to mention a Windows-specific executable, because
#: encapsulating the branch is its entire purpose.
PORTABILITY_MODULE = "portable.py"

#: Each entry is (compiled pattern, what it breaks). The messages matter: a
#: guard that only says "banned pattern" teaches nothing and gets suppressed.
BANNED = [
    (
        re.compile(r"""["']cmd["']\s*,\s*["']/c["']"""),
        "hardcodes cmd /c, which does not exist off Windows "
        "(measured in a container: FileNotFoundError: 'cmd'). "
        "Use orchestrator.portable helpers instead.",
    ),
    (
        re.compile(r"""\bmklink\b"""),
        "hardcodes mklink, a cmd builtin. Use portable.link_directory, which "
        "makes a junction on Windows (no elevation needed) and a symlink on POSIX.",
    ),
    (
        re.compile(r"""Popen\(\s*\[[^\]]*\][^)]*shell\s*=\s*True"""),
        "passes a LIST with shell=True. On POSIX that hands `sh -c` only argv[0] "
        "and silently drops every other argument — the fanout.py bug that would "
        "have produced a site with no sections.",
    ),
    (
        re.compile(r"""subprocess\.run\(\s*\[[^\]]*\][^)]*shell\s*=\s*True"""),
        "passes a LIST with shell=True — same defect as the Popen form.",
    ),
]


def python_sources() -> list[Path]:
    return sorted(p for p in SRC.rglob("*.py") if p.name != PORTABILITY_MODULE)


def test_the_guard_actually_scans_something() -> None:
    """A guard that silently scans zero files is worse than no guard.

    The same inert-coverage class as a test file the runner never loads: it
    reports success because it compared nothing.
    """
    assert len(python_sources()) > 10


@pytest.mark.parametrize("path", python_sources(), ids=lambda p: p.name)
def test_no_windows_only_spawn(path: Path) -> None:
    source = path.read_text(encoding="utf-8")
    for pattern, why in BANNED:
        match = pattern.search(source)
        assert match is None, (
            f"{path.name} {why}\n"
            f"  found: {match.group(0) if match else ''!r}\n"
            f"  If a platform branch is genuinely needed, put it in {PORTABILITY_MODULE}."
        )


def test_portable_module_is_the_one_that_branches() -> None:
    """The exemption must be real, not a hole.

    If `portable.py` stopped branching, every other module would be clean while
    the product silently went back to being Windows-only — a green guard over a
    broken behaviour.
    """
    source = (SRC / PORTABILITY_MODULE).read_text(encoding="utf-8")
    assert 'sys.platform == "win32"' in source
    assert "mklink" in source
