"""The Kitaru stack must be pinned EXPLICITLY, not inherited from saved state.

A real run died at the `plan` stage with:

    Kitaru refused to run this flow because the saved active stack appears
    stale and resolved to fallback stack `default` implicitly.
    Configured active stack from repo-local config (…/.kitaru/config.yaml):
      0e3a9b8e-7909-4d1d-8406-335293086723
    Resolved active stack: default (a239e4d1-618c-4552-a48b-a25f337b5853)

Nothing in this repo had ever named a stack, so every flow inherited Kitaru's
SAVED ACTIVE STACK — machine-local mutable state in `orchestrator/.kitaru/`
(gitignored) holding a UUID. When that UUID stops resolving, Kitaru fails closed
rather than silently running against a different metadata store and cache, which
is correct of it and useless to us: the run had already started.

WHY THIS IS A TEST AND NOT JUST A COMMENT. The fix is one line in
`pyproject.toml`, exactly the kind of line a later cleanup deletes as noise
because nothing appears to read it. These tests make that deletion loud.

WHAT IS PROVEN HERE, AND WHAT IS NOT. The guard's own first statement is
`if resolved_execution.stack_source != "zenml_active_stack": return`, so pinning
the stack from any explicit source makes the refusal unreachable — that is a
construction argument, and `test_pin_defeats_the_guard_that_actually_refused`
drives Kitaru's REAL guard with the REAL provenance shape to check it rather
than asserting the reasoning back to itself.

The one thing NOT reproduced end to end is the original failure in a live
process, and the reason is worth recording: Kitaru REWRITES the saved config to
`default` on the first read that finds the stack missing ("The current repo
active stack is no longer available. Resetting the active stack to default"). So
the refusal fires at most ONCE and then self-heals, which is why simply
re-running the failed generation would have worked. Writing a stale UUID into
`.kitaru/config.yaml` and running does NOT reproduce it — measured, twice — so
the provenance below is constructed instead, which is the only way to hold the
pre-reset state still.
"""

from __future__ import annotations

import tomllib
from pathlib import Path

import pytest

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"

# The UUID from the real failure. Any id absent from the store behaves the same;
# this one is used so the test names the incident it came from.
STALE_STACK_ID = "0e3a9b8e-7909-4d1d-8406-335293086723"


def test_pyproject_pins_a_stack() -> None:
    """`[tool.kitaru].stack` must exist, or a flow inherits saved state again."""
    config = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    kitaru = config.get("tool", {}).get("kitaru")
    assert kitaru is not None, (
        "orchestrator/pyproject.toml has no [tool.kitaru] section, so every flow "
        "falls back to Kitaru's saved active stack — the state whose going stale "
        "killed a run at the plan stage. Restore `stack = \"default\"`."
    )
    assert kitaru.get("stack"), "[tool.kitaru].stack must name a stack"


def test_the_pin_is_a_name_not_a_uuid() -> None:
    """A UUID here would be per-install and would break every other clone.

    This is the failure being fixed, inverted: a committed UUID resolves on
    exactly one machine. `stack` is typed `str | None` and resolves by name, so
    a name is both valid and portable.
    """
    config = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    stack = config["tool"]["kitaru"]["stack"]
    assert "-" not in stack or len(stack) != 36, (
        f"[tool.kitaru].stack is {stack!r}, which looks like a UUID. It must be a "
        "stack NAME so it means the same thing on every machine."
    )


def test_pin_defeats_the_guard_that_actually_refused() -> None:
    """Drive Kitaru's real guard with the real provenance shape, both ways.

    Skipped rather than failed when Kitaru's internals move: this reaches into
    private names (`_guard_implicit_active_stack_fallback`), and a rename should
    not turn into a red suite for a package we do not own. The two tests above
    keep the pin itself covered regardless.
    """
    active_context = pytest.importorskip("kitaru._config._active_context")
    flow = pytest.importorskip("kitaru.flow")
    core = pytest.importorskip("kitaru._config._core")

    guard = getattr(flow, "_guard_implicit_active_stack_fallback", None)
    provenance_cls = getattr(active_context, "ActiveConfigSelectionProvenance", None)
    if guard is None or provenance_cls is None:
        pytest.skip("Kitaru's stale-stack guard has been renamed or removed")

    default_id = "a239e4d1-618c-4552-a48b-a25f337b5853"

    # Exactly the state the incident was in: repo-local config naming a stack
    # that no longer exists, while the client resolves to `default`.
    provenance = provenance_cls(
        resource="stack",
        effective_source="repo-local config",
        effective_source_detail=str(Path("orchestrator/.kitaru/config.yaml")),
        effective_id=STALE_STACK_ID,
    )

    class _Stack:
        name = "default"
        id = default_id

    class _Client:
        active_stack_model = _Stack()

    def resolved(source: str) -> object:
        return core.ResolvedExecutionConfig(
            stack="default", stack_source=source, image=None, cache=None, retries=0
        )

    # WITHOUT an explicit pin: the guard refuses. This is the reported failure.
    with pytest.raises(Exception) as refusal:
        guard(
            operation="run this flow",
            resolved_execution=resolved("zenml_active_stack"),
            raw_active_stack_provenance=provenance,
            client_factory=_Client,
        )
    assert "stale" in str(refusal.value)

    # WITH the pin (`project_config` is the layer `[tool.kitaru]` populates):
    # the guard returns before it can refuse.
    guard(
        operation="run this flow",
        resolved_execution=resolved("project_config"),
        raw_active_stack_provenance=provenance,
        client_factory=_Client,
    )


def test_the_pin_is_what_the_resolver_actually_reports() -> None:
    """End of the chain: the real resolver must report the explicit layer.

    The test above proves the guard's behaviour per `stack_source`; this proves
    that OUR pyproject is what produces the value that skips it. Without this
    pair, both halves could be right about a `stack_source` nothing sets.
    """
    kconfig = pytest.importorskip("kitaru.config")
    resolve = getattr(kconfig, "resolve_execution_config", None)
    if resolve is None:
        pytest.skip("kitaru.config.resolve_execution_config has been renamed")

    assert resolve().stack_source != "zenml_active_stack", (
        "the resolved stack still comes from Kitaru's saved active stack, so the "
        "stale-stack refusal is reachable again"
    )
