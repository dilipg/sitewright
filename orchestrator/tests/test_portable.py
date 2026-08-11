"""Cross-platform process/filesystem behaviour (task 3b).

WHY THESE ASSERT ON BEHAVIOUR AND NEVER ON AN ARGV ARRAY: `["cmd", "/c", "npx",
"tsc", "--noEmit"]` is a perfectly well-formed argv. A test that pinned it would
pin the BUG, and would keep passing on a platform where the command cannot run
at all -- which is exactly how six spawn sites shipped Windows-only for seven
milestones. So: the link helper must produce a link that RESOLVES, and the
typecheck helper must actually make a real `tsc` report a real type error.

One test here is a source-level prohibition rather than a behavioural check
(`test_the_windows_shell_lives_in_exactly_one_module`). That is deliberate and
is not an argv-shape assertion about the fix: four of the six sites have no
other coverage (`soak.py` is a CLI, `fanout.py` spawns real page workers), and
the property being pinned is "the platform branch is single-sourced", which is
what stops a seventh site from being written the old way.
"""

import ast
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

from orchestrator import portable
from orchestrator.portable import (
    ExecutableNotFound,
    link_directory,
    resolve_executable,
    run_project_typecheck,
)
from orchestrator.config import ORCHESTRATOR_ROOT
from orchestrator.section_pipeline import GENERATED_DIR

ORCHESTRATOR_SRC = ORCHESTRATOR_ROOT / "src" / "orchestrator"


def _unlink_directory_link(link: Path) -> None:
    """Removes a directory link WITHOUT following it.

    Every test that makes a link removes it again before pytest's own tmp_path
    reaper can walk one. This is not politeness: task 3 destroyed 195 tracked
    files when `git worktree remove --force` traversed a junction into a live
    node_modules tree. Nothing here links outside its own tmp_path, so the
    blast radius is already zero -- this keeps it that way by construction.

    Two calls because Windows disagrees with POSIX about which one applies to a
    junction, and `os.path.islink()` answers False for one (measured on this
    host), so branching on it would pick the wrong call.
    """
    try:
        link.unlink()
    except OSError:
        os.rmdir(link)


# ---------- the link helper ----------


def test_link_directory_creates_a_link_that_resolves_to_the_source(tmp_path: Path) -> None:
    """The generated project borrows the fixture's node_modules through this
    link, so the only thing that matters is that reads through it land on the
    source tree. Junction (Windows) vs symlink (POSIX) is an implementation
    detail this test deliberately cannot see."""
    source = tmp_path / "source"
    source.mkdir()
    (source / "marker.txt").write_text("borrowed", encoding="utf-8")
    link = tmp_path / "node_modules"

    link_directory(link, source)
    try:
        assert link.is_dir()
        assert (link / "marker.txt").read_text(encoding="utf-8") == "borrowed"
        assert link.resolve() == source.resolve()
    finally:
        _unlink_directory_link(link)


def test_link_directory_leaves_the_source_reachable_by_its_own_path(tmp_path: Path) -> None:
    """A copy would also satisfy the test above. This pins that the source is
    still one tree: writing through the link is visible at the source path."""
    source = tmp_path / "source"
    source.mkdir()
    link = tmp_path / "node_modules"

    link_directory(link, source)
    try:
        (link / "written-through-the-link.txt").write_text("x", encoding="utf-8")
        assert (source / "written-through-the-link.txt").read_text(encoding="utf-8") == "x"
    finally:
        _unlink_directory_link(link)


# ---------- the executable resolver ----------


def test_resolve_executable_returns_a_path_that_exists() -> None:
    """`npx` on Windows is `npx.CMD`; there is no extensionless `npx` file at
    all, which is the entire reason `cmd /c` was ever there. Resolving it is
    what lets the spawn stay shell-free on both platforms."""
    resolved = Path(resolve_executable("npx"))
    assert resolved.is_file()


def test_resolve_executable_names_the_tool_when_it_is_missing() -> None:
    with pytest.raises(ExecutableNotFound) as raised:
        resolve_executable("webgen-no-such-tool-exists")
    assert "webgen-no-such-tool-exists" in str(raised.value)


# ---------- the typecheck helper ----------


def _scratch_project(name: str) -> Path:
    """A throwaway project under `generated/`, the repo's own disposable
    workspace, rather than under tmp_path -- because `npx` resolves a binary by
    walking UP from cwd, so a project outside the repo would find no typescript
    and try to DOWNLOAD one. Inside the repo it resolves this repo's own tsc,
    offline. Contains no links, so removing it is an ordinary rmtree."""
    project = GENERATED_DIR / f".test-{name}-{uuid.uuid4().hex[:8]}"
    project.mkdir(parents=True)
    (project / "tsconfig.json").write_text(
        '{"compilerOptions":{"strict":true,"noEmit":true,"module":"esnext",'
        '"target":"es2022","moduleResolution":"bundler"},"include":["*.ts"]}\n',
        encoding="utf-8",
    )
    return project


def test_run_project_typecheck_invokes_a_real_tsc() -> None:
    """BOTH halves are needed to discriminate: a helper that always failed would
    satisfy the first assertion, and one that never ran anything would satisfy
    the second. Together they can only pass if a real compiler read the file."""
    project = _scratch_project("typecheck")
    try:
        source = project / "subject.ts"

        source.write_text("export const n: number = 'not a number';\n", encoding="utf-8")
        failed = run_project_typecheck(project)
        assert failed.returncode != 0
        # stdout, not stderr: this is where both pipelines read the diagnostics
        # they feed back to the model as a failure report.
        assert "error TS2322" in failed.stdout

        source.write_text("export const n: number = 1;\n", encoding="utf-8")
        passed = run_project_typecheck(project)
        assert passed.returncode == 0, passed.stdout + passed.stderr
    finally:
        shutil.rmtree(project, ignore_errors=True)


# ---------- the spawn helper (page fan-out) ----------


def test_spawn_delivers_every_argument_to_the_child() -> None:
    """`Popen(list, shell=True)` -- what `fanout.spawn_worker` used to do --
    passes ONLY argv[0] to `sh -c` on POSIX and turns the rest into the SHELL's
    positional parameters, so `uv run python -m orchestrator.page_worker …` ran
    a bare `uv` and no page worker ever started. Windows hid it completely,
    because Popen list2cmdline's the whole list into `cmd /c`.

    So the property under test is that the arguments arrive, proven by having
    the child print them back."""
    proc = portable.spawn(
        [
            "uv",
            "run",
            "python",
            "-c",
            "import sys; print('|'.join(sys.argv[1:]))",
            "alpha",
            "beta gamma",
        ],
        cwd=ORCHESTRATOR_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )
    stdout, stderr = proc.communicate(timeout=300)
    assert proc.returncode == 0, stderr
    assert stdout.strip().splitlines()[-1] == "alpha|beta gamma"


# ---------- the prohibition ----------


def test_the_windows_shell_lives_in_exactly_one_module() -> None:
    """`cmd` does not exist off Windows, and `mklink` is a cmd BUILTIN, so the
    Windows branch genuinely needs a shell -- in one place. Anywhere else it is
    the defect this task removed: `FileNotFoundError: 'cmd'` inside a
    @checkpoint, killing a run after partial spend.

    `shell=True` is prohibited outright, with no exception: these argv arrays
    carry model-influenced paths, and a shell is the injection surface this repo
    already fixed once."""
    offenders_cmd: list[str] = []
    offenders_shell: list[str] = []
    for module in sorted(ORCHESTRATOR_SRC.glob("*.py")):
        text = module.read_text(encoding="utf-8")
        # AST rather than a substring for this half, because this file and
        # portable.py both DISCUSS `shell=True` in prose and neither may be
        # exempted from the rule itself.
        for node in ast.walk(ast.parse(text)):
            if not isinstance(node, ast.Call):
                continue
            for keyword in node.keywords:
                if keyword.arg != "shell":
                    continue
                is_explicit_false = (
                    isinstance(keyword.value, ast.Constant) and keyword.value.value is False
                )
                if not is_explicit_false:
                    offenders_shell.append(f"{module.name}:{node.lineno}")
        # portable.py is the ONE module allowed to name the Windows shell, and
        # it is exempt from this half only -- never from the shell=True rule
        # above. `text`, not AST, because prose describing the old defect is
        # exactly as bad here as code: nothing outside portable.py should have
        # any reason to mention either.
        if module.name == "portable.py":
            continue
        if '"cmd", "/c"' in text or "mklink" in text:
            offenders_cmd.append(module.name)

    assert offenders_shell == []
    assert offenders_cmd == []
    # …and the branch itself still exists, so this cannot be satisfied by
    # deleting the Windows support the only working platform depends on.
    assert "mklink" in (ORCHESTRATOR_SRC / "portable.py").read_text(encoding="utf-8")
