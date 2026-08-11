"""The one place the orchestrator knows what platform it is on (task 3b).

Six spawn sites used to hardcode `["cmd", "/c", …]`. `cmd` does not exist off
Windows, so inside any Linux container they raised
`FileNotFoundError: [Errno 2] No such file or directory: 'cmd'` -- and
`design_pipeline.write_primitives` is a `@checkpoint`, so the run died AFTER
intake, planning, tokens and primitives had already been paid for. The product
was Windows-only for seven milestones and nobody could tell, because Windows is
where it was developed.

THIS IS BRANCHING, NOT SUBSTITUTION. Both halves of the Windows behaviour are
load-bearing, and the naive "make it portable" rewrite breaks the only platform
that works today:

1. `mklink /J` makes a JUNCTION, and a junction needs no elevation. `os.symlink`
   on Windows requires Developer Mode or administrator rights, so swapping the
   junction for a symlink would break every ordinary Windows checkout. Hence
   junction on Windows, `os.symlink(target_is_directory=True)` on POSIX.
   `mklink` is a `cmd` BUILTIN, not an executable, so that branch genuinely
   needs `cmd` -- which is why this module is allowed to name it and no other
   module is (`tests/test_portable.py` pins that).

2. `npx` on Windows is `npx.CMD`. There is no extensionless `npx` file, so a
   bare `["npx", …]` raises `FileNotFoundError` there -- the entire reason
   `cmd /c` was ever in front of it. `shutil.which` finds the real file and
   `CreateProcess` runs a `.CMD` with no shell at all; Python's own docs are
   explicit that "you do not need shell=True to run a batch file". Measured on
   the Windows host this was written on: `which("npx")` ->
   `C:\\Program Files\\nodejs\\npx.CMD`, and
   `subprocess.run([that, "tsc", "--version"], shell=False)` returns 0.

`shell=False` everywhere, with no exception. These argv arrays carry
model-influenced paths (a project directory named from a run id, a route slug),
and a shell would reintroduce the argument-splitting/injection surface this repo
already fixed once -- `runProcess`'s `shell: true`, where Node concatenated argv
and "make the headline shorter" arrived as five arguments.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

# The typecheck a generated project runs against itself. Long because a cold
# `npx tsc` on a freshly linked node_modules is not fast, and because a timeout
# here reads to the model as "typecheck failed" rather than "the box was busy".
TYPECHECK_TIMEOUT_S = 300


class ExecutableNotFound(RuntimeError):
    """A tool the pipeline spawns is not on PATH.

    Raised deliberately instead of letting `FileNotFoundError: 'cmd'` surface
    from inside a `@checkpoint`, which is what the Windows-only spawn sites did:
    the message named `cmd`, a tool nobody had asked for, on a platform where it
    was never going to exist.
    """


def resolve_executable(name: str) -> str:
    """Absolute path to `name` on PATH, so it can be spawned with no shell.

    On Windows this is what turns `npx` into `npx.CMD`; on POSIX it is a
    no-op-ish lookup that buys a legible error instead of an ENOENT from Popen.
    """
    found = shutil.which(name)
    if found is None:
        raise ExecutableNotFound(
            f"{name!r} is not on PATH, so the pipeline cannot spawn it. "
            f"Node (for npx) and uv must both be present in the environment the "
            f"orchestrator runs in -- inside a container that means the RUNNING "
            f"image, not just the build stage."
        )
    return found


def link_directory(link: Path, source: Path) -> None:
    """Creates `link` as a directory link pointing at `source`.

    A generated project borrows the fixture's `node_modules` this way rather
    than copying ~400MB per run, so the preview server, the typecheck and the
    export verification build all have something to resolve against.

    Junction on Windows (no elevation required), symlink on POSIX. Callers check
    that `link` does not already exist; this deliberately does not, so an
    unexpected collision surfaces rather than being papered over.
    """
    if sys.platform == "win32":
        # `mklink` is a cmd builtin -- there is no mklink.exe -- so this is the
        # one place in the orchestrator that legitimately spawns a shell binary.
        # Still shell=False: cmd is the PROGRAM here, not an interpreter wrapped
        # around a concatenated command string.
        subprocess.run(
            [resolve_executable("cmd"), "/c", "mklink", "/J", str(link), str(source)],
            check=True,
            capture_output=True,
        )
    else:
        os.symlink(source, link, target_is_directory=True)


def run_npx(
    args: list[str],
    *,
    cwd: Path,
    timeout: int,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess:
    """Runs a project-local Node tool through `npx`, resolved and shell-free.

    `text=True, encoding="utf-8"` is kept from the call sites this replaced:
    generated content reaches these diagnostics, and the Windows default code
    page mangles it.
    """
    return subprocess.run(
        [resolve_executable("npx"), *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=timeout,
        env=env,
    )


def run_project_typecheck(project_dir: Path) -> subprocess.CompletedProcess:
    """The generated project's own `tsc --noEmit`.

    Callers read `.stdout` (not stderr) -- that is where tsc writes diagnostics,
    and both pipelines feed those lines back to the model as a failure report.
    """
    return run_npx(["tsc", "--noEmit"], cwd=project_dir, timeout=TYPECHECK_TIMEOUT_S)


def spawn(argv: list[str], **kwargs) -> subprocess.Popen:
    """`Popen` with argv[0] resolved on PATH and no shell.

    The bug this exists to prevent: `Popen(list, shell=True)` on POSIX passes
    ONLY argv[0] to `sh -c` and turns everything after it into the SHELL's
    positional parameters. `["uv", "run", "python", "-m",
    "orchestrator.page_worker", …]` therefore ran a bare `uv`, printed its help
    and exited non-zero, so every page worker "crashed" for a reason no log
    explained. Windows hid it completely, because Popen list2cmdline's the whole
    list into a single `cmd /c` command line.
    """
    return subprocess.Popen([resolve_executable(argv[0]), *argv[1:]], **kwargs)
