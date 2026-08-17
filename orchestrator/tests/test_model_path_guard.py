"""No module may join a model-authored path key onto a project root itself.

WHY THIS EXISTS: this codebase has now shipped TEN path-traversal defects at
four different layers (an unvalidated proxied ``route`` joined with
``path.join``; a ``runId`` rail whose character class matched ``..`` because
``.`` was in the class; a project id where one ``encodeURIComponent`` pass is
insufficient; model-generated ``route.slug`` interpolated raw into a URL). The
tenth -- recorded as ``M4`` -- was three write loops that did

    for rel_path, content in result["files"].items():
        (Path(project_dir) / rel_path).write_text(content)

where ``rel_path`` is a KEY OF THE MODEL'S OWN structured output. Two failure
modes, both measured:

* ``Path('/project') / '../../evil.ts'`` -> ``/project/../../evil.ts``, which
  traverses the moment anything normalises it.
* ``Path('/project') / '/etc/passwd'`` -> ``/etc/passwd``. pathlib does NOT
  join an absolute right-hand side, it REPLACES -- so a ``..``-only guard lets
  it through untouched, and ``mkdir(parents=True)`` then CREATES whatever
  directory chain it names.

Spot-fixing the three sites is exactly what let the previous nine accumulate,
so this guard is the part that stops an ELEVENTH. ``safe_path.py`` is the ONE
module allowed to turn a model-authored string into a filesystem path, because
refusing the ones that escape is its entire purpose.

WHAT THIS GUARD DOES AND DOES NOT COVER -- stated plainly, because a guard
whose reach is overstated is worse than none. It detects the shape all four
known instances take: a path built by dividing by a name BOUND BY A LOOP over
something that is not a source literal, which is then written to. It does NOT
detect a model-authored string that arrives as a plain function PARAMETER
(``route_slug``, ``run_id``) and is joined onto a path -- that is a different
defect class with a different fix (a slug/id shape validator, mirroring
``compiler/src/route-slug.ts``), and it is recorded in ``docs/pending.md``
rather than silently implied to be covered here.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src" / "orchestrator"

#: The only module permitted to join a model-authored path onto a root,
#: because refusing the ones that escape is precisely its job.
SAFE_PATH_MODULE = "safe_path.py"

#: Methods that CREATE or REPLACE something on disk. A read (`read_text`,
#: `exists`, `iterdir`) is deliberately absent: `section_pipeline` legitimately
#: builds `project / file_path` for every manifest-declared source file in a
#: comprehension, and those paths were already validated by the manifest
#: service's own `unsafeRelativePath` before they were ever persisted.
WRITE_METHODS = frozenset(
    {
        "write_text",
        "write_bytes",
        "mkdir",
        "touch",
        "symlink_to",
        "hardlink_to",
        "rename",
        "replace",
        "unlink",
        "rmdir",
    }
)

#: `shutil` helpers whose every positional argument is a filesystem path.
SHUTIL_WRITES = frozenset({"copy", "copy2", "copyfile", "copytree", "move", "rmtree", "make_archive"})

#: An `open()` mode that creates or truncates. A bare `open(p)` is a read.
WRITE_MODES = frozenset({"w", "a", "x", "+"})


def python_sources() -> list[Path]:
    return sorted(p for p in SRC.rglob("*.py") if p.name != SAFE_PATH_MODULE)


def _target_names(target: ast.expr) -> list[str]:
    """Names bound by a `for` target, flattening tuple/list unpacking."""
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        names: list[str] = []
        for element in target.elts:
            names.extend(_target_names(element))
        return names
    return []


def _is_literal_collection(node: ast.expr) -> bool:
    """`("sections", "mock")` — every value the loop variable can take is a
    string literal written in this file, so it cannot carry model output.

    This exemption is principled rather than an allowlist: it is decided by
    the shape of the iterable, so it cannot go stale as call sites change.
    """
    if not isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return False
    return all(isinstance(element, ast.Constant) for element in node.elts)


SCOPE_NODES = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)


def _scopes(tree: ast.Module) -> list[ast.AST]:
    """The module plus every function/lambda, each analysed on its own.

    Scoping matters for precision, not just tidiness: analysed module-wide, a
    binding named `target` in one function makes every `target.write_text` in
    the file resolve through it, and the guard reports fourteen lines for one
    defect. A guard that cries wolf is a guard that gets suppressed.
    """
    return [tree, *(node for node in ast.walk(tree) if isinstance(node, SCOPE_NODES))]


def _scope_nodes(scope: ast.AST) -> list[ast.AST]:
    """Every node belonging to `scope` itself — descending through statements
    and comprehensions, but never into a nested function, which `_scopes`
    already yields separately."""
    collected: list[ast.AST] = []
    stack = list(ast.iter_child_nodes(scope))
    while stack:
        node = stack.pop()
        collected.append(node)
        if isinstance(node, SCOPE_NODES):
            continue
        stack.extend(ast.iter_child_nodes(node))
    return collected


def _loop_bound_names(nodes: list[ast.AST]) -> set[str]:
    """Every name bound by a `for` statement or a comprehension whose iterable
    is not a literal collection — i.e. every name that could be carrying a key
    out of a model-authored mapping."""
    names: set[str] = set()
    for node in nodes:
        if isinstance(node, (ast.For, ast.AsyncFor)) and not _is_literal_collection(node.iter):
            names.update(_target_names(node.target))
        elif isinstance(node, ast.comprehension) and not _is_literal_collection(node.iter):
            names.update(_target_names(node.target))
    return names


def _simple_assignments(nodes: list[ast.AST]) -> dict[str, list[ast.expr]]:
    """`target = <expr>` bindings, so `t = base / key` followed by
    `t.parent.mkdir()` is seen as one flow rather than two unrelated nodes."""
    bindings: dict[str, list[ast.expr]] = {}
    for node in nodes:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    bindings.setdefault(target.id, []).append(node.value)
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.value:
            bindings.setdefault(node.target.id, []).append(node.value)
        elif isinstance(node, ast.NamedExpr) and isinstance(node.target, ast.Name):
            bindings.setdefault(node.target.id, []).append(node.value)
    return bindings


def _divides_by_loop_name(
    expr: ast.expr,
    loop_names: set[str],
    bindings: dict[str, list[ast.expr]],
    seen: frozenset[str] = frozenset(),
) -> ast.BinOp | None:
    """The offending `<root> / <loop-bound name>` inside `expr`, if any.

    Follows one level of `Name` indirection through `bindings` so the two
    spellings the codebase actually uses -- the inline
    `(project / rel_path).write_text(...)` and the two-step
    `target = Path(project_dir) / rel_path; target.write_text(...)` -- are
    both caught. `seen` stops a self-referential binding looping forever.
    """
    for node in ast.walk(expr):
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            if isinstance(node.right, ast.Name) and node.right.id in loop_names:
                return node
    for node in ast.walk(expr):
        if isinstance(node, ast.Name) and node.id in bindings and node.id not in seen:
            for value in bindings[node.id]:
                found = _divides_by_loop_name(value, loop_names, bindings, seen | {node.id})
                if found is not None:
                    return found
    return None


def _has_write_mode(call: ast.Call) -> bool:
    """`open(p, "w")` / `p.open(mode="a")` writes; `open(p)` does not."""
    mode: str | None = None
    if len(call.args) >= 2 and isinstance(call.args[1], ast.Constant):
        mode = call.args[1].value if isinstance(call.args[1].value, str) else None
    for keyword in call.keywords:
        if keyword.arg == "mode" and isinstance(keyword.value, ast.Constant):
            mode = keyword.value.value if isinstance(keyword.value.value, str) else None
    if mode is None:
        return False
    return any(character in WRITE_MODES for character in mode)


def _write_path_expressions(call: ast.Call) -> list[ast.expr]:
    """The path expression(s) a call would write to, or []."""
    func = call.func
    if isinstance(func, ast.Attribute):
        if func.attr in WRITE_METHODS:
            return [func.value]
        if func.attr == "open" and _has_write_mode(call):
            return [func.value]
        if (
            isinstance(func.value, ast.Name)
            and func.value.id == "shutil"
            and func.attr in SHUTIL_WRITES
        ):
            return list(call.args)
    if isinstance(func, ast.Name) and func.id == "open" and _has_write_mode(call):
        return list(call.args[:1])
    return []


def unguarded_model_path_writes(source: str) -> list[tuple[int, str]]:
    """(line, source text) for every write to a path divided by a loop-bound
    name. Exported as a function so the guard's own detection can be tested."""
    tree = ast.parse(source)
    findings: list[tuple[int, str]] = []
    for scope in _scopes(tree):
        nodes = _scope_nodes(scope)
        loop_names = _loop_bound_names(nodes)
        if not loop_names:
            continue
        bindings = _simple_assignments(nodes)
        for node in nodes:
            if not isinstance(node, ast.Call):
                continue
            for path_expr in _write_path_expressions(node):
                offender = _divides_by_loop_name(path_expr, loop_names, bindings)
                if offender is not None:
                    findings.append((node.lineno, ast.unparse(offender)))
    return sorted(set(findings))


def test_the_guard_actually_scans_something() -> None:
    """A guard that silently scans zero files is worse than no guard — the same
    inert-coverage class as a test file the runner never loads."""
    assert len(python_sources()) > 10


def test_the_guard_detects_the_defect_it_names() -> None:
    """The scanner is the load-bearing half of this file; a scanner that
    matched nothing would leave every module below trivially green.

    This is the exact code that shipped, verbatim in shape.
    """
    shipped = (
        "from pathlib import Path\n"
        "def write(project_dir, files):\n"
        "    for rel_path, content in files.items():\n"
        "        target = Path(project_dir) / rel_path\n"
        "        target.parent.mkdir(parents=True, exist_ok=True)\n"
        "        target.write_text(content)\n"
    )
    assert unguarded_model_path_writes(shipped), "the scanner missed the defect it was written for"

    inline = (
        "def write(project, files):\n"
        "    for rel_path, content in files.items():\n"
        "        (project / rel_path).write_text(content)\n"
    )
    assert unguarded_model_path_writes(inline), "the scanner missed the inline spelling"

    fixed = (
        "from orchestrator.safe_path import safe_project_path\n"
        "def write(project_dir, files):\n"
        "    for rel_path, content in files.items():\n"
        "        target = safe_project_path(project_dir, rel_path)\n"
        "        target.write_text(content)\n"
    )
    assert not unguarded_model_path_writes(fixed), "the scanner flags the FIXED shape — it would be unusable"

    reads = (
        "def read(project, files):\n"
        "    return [(project / f).read_text() for f in files]\n"
    )
    assert not unguarded_model_path_writes(reads), "the scanner flags a read — it would be unusable"


@pytest.mark.parametrize("path", python_sources(), ids=lambda p: p.name)
def test_no_unguarded_model_path_write(path: Path) -> None:
    findings = unguarded_model_path_writes(path.read_text(encoding="utf-8"))
    assert not findings, (
        f"{path.name} joins a loop-bound key onto a path and writes to it, with no containment check.\n"
        + "".join(f"  line {line}: {text}\n" for line, text in findings)
        + f"  A model-authored key can be '../../evil.ts' (traverses) or '/etc/passwd'\n"
        f"  (pathlib DISCARDS the root for an absolute right-hand side).\n"
        f"  Use orchestrator.safe_path.safe_project_path, which refuses both."
    )


def test_the_exemption_is_real() -> None:
    """The exemption must be a working helper, not a hole.

    If `safe_path.py` stopped refusing, every module above would still be
    clean while the product was wide open again — a green guard over a broken
    behaviour. Asserted BEHAVIOURALLY rather than by grepping the module for
    a keyword: a gutted helper that still contained the word would pass a
    text check.
    """
    from orchestrator.safe_path import UnsafeModelPath, safe_project_path

    for escaping in ("../../evil.ts", "/etc/passwd", "C:/Windows/system32/x.ts"):
        with pytest.raises(UnsafeModelPath):
            safe_project_path("project", escaping)
    assert safe_project_path("project", "src/pages/home/index.tsx").name == "index.tsx"
