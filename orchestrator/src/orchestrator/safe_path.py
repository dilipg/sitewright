"""The one place a MODEL-AUTHORED path becomes a filesystem path (task M4).

Every code-generating agent returns its output as a `files` mapping whose KEYS
are paths it chose itself. Three write loops joined those keys straight onto
the project root:

    for rel_path, content in result["files"].items():
        (Path(project_dir) / rel_path).write_text(content)

`rel_path` is a key of the model's own structured output, so it is untrusted
input by definition. TWO distinct failure modes, both measured on this host
before this module was written:

    Path('/project') / '../../evil.ts'  ->  /project/../../evil.ts
    Path('/project') / '/etc/passwd'    ->  /etc/passwd

The second is the subtle one and is exactly how a `..`-only guard gets shipped
believing it is finished: **pathlib does not JOIN an absolute right-hand side,
it REPLACES** — the project root is discarded silently, no `..` appears
anywhere, and `mkdir(parents=True)` then CREATES whatever directory chain the
model named. This is the tenth path-traversal defect in this codebase, after
nine at four other layers (an unvalidated proxied `route` through `path.join`;
a `runId` rail whose character class `^[A-Za-z0-9._-]+$` matched `..` because
`.` was in the class; a project id where one `encodeURIComponent` pass is
insufficient; model-generated `route.slug` interpolated raw into a URL).

REFUSE, NEVER SANITISE. A path that tries to escape is a model producing
something contract section 2 forbids, and quietly rewriting it to something
"safe" would hide a real generation defect behind a file that silently landed
somewhere else. This repo's precedent is consistent — `loadMasterKey`,
`shutdown-budget.ts` and `max_parallel_workers` all refuse rather than clamp.

THE CHECK IS PLATFORM-INDEPENDENT BY CONSTRUCTION. Both the POSIX and the
Windows interpretation of a path are applied on EVERY platform, so the same
model output is refused identically on a Windows dev box and in a Linux
container. That is not decoration: this product was Windows-only for seven
milestones and nobody could tell (see `portable.py`), and a guard that refuses
`C:/x` only on Windows would leave the container open to the form the check
was written for. Measured on Python 3.12: `PureWindowsPath('/etc/passwd')`
reports `is_absolute() == False` (it has a root but no drive) and
`PureWindowsPath('C:relative')` likewise (drive but no root), so `is_absolute`
ALONE is not a sufficient test — `drive or root` is what this module uses.

TWO LAYERS, DELIBERATELY. `safe_project_path` raises, which is the structural
half: a future write site is safe because it cannot obtain a path any other
way. `unsafe_model_paths` reports the same refusals as a list of strings, so a
pipeline's existing retry loop can turn a bad path into a failure report the
model gets a chance to fix, rather than an exception that kills a run mid-spend.
Where a pipeline has that loop, the raise is unreachable in practice — the same
"unreachable today, and this is the seam a future caller goes through" argument
`server/src/jobs.ts`'s `recordJobRun` throw rests on.
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath, PureWindowsPath


class UnsafeModelPath(ValueError):
    """A model-authored path that would write outside the project root."""


def unsafe_reason(rel_path: object) -> str | None:
    """Why `rel_path` may not be joined onto a project root, or None.

    Shape checks only — see `safe_project_path` for the containment check that
    backs these up against anything the shape scan cannot see (a symlinked
    directory component being the case that matters).
    """
    if not isinstance(rel_path, str):
        return f"is not a string (got {type(rel_path).__name__})"
    if rel_path == "":
        return "is empty"
    if "\x00" in rel_path:
        return "contains a NUL byte"

    windows = PureWindowsPath(rel_path)
    posix = PurePosixPath(rel_path)
    # `drive or root`, not `is_absolute()`: on Python 3.12 a Windows path needs
    # BOTH to be "absolute", so `/etc/passwd` (root, no drive) and `C:relative`
    # (drive, no root) both report False while both still discard or relocate
    # the root when joined. Checked in both flavours on both platforms.
    if windows.drive or windows.root or posix.root:
        return "is absolute (pathlib DISCARDS the project root for an absolute right-hand side)"

    # Both separators, unconditionally: a model-authored key HAS arrived with
    # backslashes before (see `section_pipeline.is_mock_data_file`), and a
    # POSIX-only split would let `..\\..\\evil.ts` through on the one platform
    # where `\` is a real separator.
    segments = rel_path.replace("\\", "/").split("/")
    if ".." in segments:
        return "contains a `..` segment"
    if "" in segments:
        return "has an empty path segment"
    return None


def safe_project_path(project_dir: str | Path, rel_path: str) -> Path:
    """`project_dir / rel_path`, or raise `UnsafeModelPath`.

    Returns the SAME expression the call sites built before this module
    existed — `Path(project_dir) / rel_path`, unresolved and un-normalised —
    so every path that is accepted still writes to exactly the byte-identical
    location it used to. This function subtracts paths; it never rewrites one.

    The second check is a containment test performed AFTER `resolve()`, which
    is what the shape scan cannot do on its own: `resolve()` follows symlinks,
    and a generated project really does contain one (`node_modules` is a
    junction into the fixture), so a component that is a link out of the tree
    is caught here rather than assumed away.
    """
    reason = unsafe_reason(rel_path)
    if reason is not None:
        # `!r` on the model's own string (control characters and a stray
        # backslash must be visible), plain on the root (repr would double
        # every separator on Windows and make the message unreadable).
        raise UnsafeModelPath(
            f"model-authored path {rel_path!r} {reason}; it may not be written under "
            f"{project_dir}. Agents write only relative paths inside the project "
            f"(contract section 2 ownership map)."
        )

    base = Path(project_dir)
    target = base / rel_path
    resolved_root = base.resolve()
    resolved_target = target.resolve()
    if resolved_target == resolved_root or not resolved_target.is_relative_to(resolved_root):
        raise UnsafeModelPath(
            f"model-authored path {rel_path!r} resolves to {resolved_target}, which is "
            f"outside the project root {resolved_root} (a symlinked path component can "
            f"escape a tree that no `..` scan would flag)."
        )
    return target


def unsafe_model_paths(files: object) -> list[str]:
    """One issue string per unsafe key in a model's `files` mapping.

    Returned rather than raised so a pipeline's existing retry loop can hand
    the model a failure report and let it try again — a run that has already
    paid for intake, planning, tokens and primitives should not die on a
    fixable output shape. `files` is typed `object` for the same reason
    `section_pipeline.files_of` is defensive: tool-use does not hard-enforce a
    declared schema, and a non-mapping here must produce a clean report rather
    than an AttributeError.
    """
    if not isinstance(files, dict):
        return []
    return [
        f"file path {key!r} {unsafe_reason(key)} — write only relative paths inside the project"
        for key in files
        if unsafe_reason(key) is not None
    ]
