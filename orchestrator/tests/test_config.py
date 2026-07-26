"""Model tiering table (pipeline section 3) resolved as config."""

import pytest

from orchestrator.config import ROLE_TIERS, TIER_MODELS, resolve_model


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
