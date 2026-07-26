"""DESIGN CONTEXT builder: compact token summary + primitive signatures,
under 600 tokens by a conservative estimate (pipeline 4.1)."""

from orchestrator.design_context import build_design_context, estimate_tokens
from orchestrator.fixture_context import fixture_primitive_signatures, fixture_tokens


def test_fixture_design_context_stays_under_600_tokens() -> None:
    context = build_design_context(fixture_tokens(), fixture_primitive_signatures())
    assert estimate_tokens(context) < 600, f"estimated {estimate_tokens(context)} tokens"


def test_context_names_semantic_colors_and_scales() -> None:
    context = build_design_context(fixture_tokens(), fixture_primitive_signatures())
    assert "accent" in context
    assert "textMuted" in context
    assert "space:" in context
    assert "5xl" in context


def test_context_lists_every_primitive_signature() -> None:
    context = build_design_context(fixture_tokens(), fixture_primitive_signatures())
    for name in ("Button", "Heading", "Text", "Container"):
        assert name in context


def test_estimate_tokens_is_conservative() -> None:
    # ~4 chars/token is typical for English+code; the estimator must not undercount
    assert estimate_tokens("word " * 100) >= 100
    assert estimate_tokens("") == 0
