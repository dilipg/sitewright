"""Model tiering table (pipeline section 3) resolved as config."""

import pytest

from orchestrator.config import GEMINI_TIER_MODELS, ROLE_TIERS, TIER_MODELS, resolve_model


def test_every_pipeline_role_has_a_tier() -> None:
    assert set(ROLE_TIERS) == {
        "intake",
        "planner",
        "design-system",
        "shell",
        "page",
        "export-cleanup",
    }


def test_roles_resolve_to_tier_models() -> None:
    assert resolve_model("page") == TIER_MODELS["top"]
    assert resolve_model("intake") == TIER_MODELS["mid"]
    assert resolve_model("export-cleanup") == TIER_MODELS["small"]


def test_unknown_role_fails_loudly() -> None:
    with pytest.raises(KeyError, match="unknown-role"):
        resolve_model("unknown-role")


def test_default_provider_is_anthropic_regardless_of_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """The Gemini path is an opt-in escape hatch (decisions.md), never the
    default — every other role/tier test in this file must keep resolving
    Anthropic models whether or not ORCH_MODEL_PROVIDER is unset."""
    monkeypatch.delenv("ORCH_MODEL_PROVIDER", raising=False)
    assert resolve_model("page") == TIER_MODELS["top"]


def test_gemini_provider_resolves_gemini_models_when_explicitly_selected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ORCH_MODEL_PROVIDER", "gemini")
    assert resolve_model("page") == GEMINI_TIER_MODELS["top"]
    assert resolve_model("intake") == GEMINI_TIER_MODELS["mid"]
