"""Runtime configuration: .env loading and the model tiering table
(agent-pipeline-spec section 3) as config. Gate-failure retries reuse the
original call's model by design (changing models mid-retry confounds
debugging), so retries resolve through the same role."""

import os
from pathlib import Path

from dotenv import load_dotenv

ORCHESTRATOR_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ORCHESTRATOR_ROOT / ".env")

TIER_MODELS: dict[str, str] = {
    "top": "claude-sonnet-5",
    "mid": "claude-haiku-4-5-20251001",
    "small": "claude-haiku-4-5-20251001",
}

# Gemini tier mapping: an OPT-IN escape hatch (ORCH_MODEL_PROVIDER=gemini),
# not a target architecture change — the contract specifies the Claude API
# ("the Claude API is called through the adapter layer", pipeline 5.1).
# Added to unblock development during an Anthropic billing outage; default
# provider stays "anthropic" (docs/decisions.md).
GEMINI_TIER_MODELS: dict[str, str] = {
    # all tiers on flash: the free-tier key has zero quota for gemini-pro-latest
    "top": "gemini-flash-latest",
    "mid": "gemini-flash-latest",
    "small": "gemini-flash-latest",
}

ROLE_TIERS: dict[str, str] = {
    "intake": "mid",
    "planner": "mid",
    "design-system": "top",
    "shell": "mid",
    "page": "top",
    "export-cleanup": "small",
    # Prompt-driven editing. Resolving an instruction to {node, channel, token}
    # is lookup and mapping, not authoring — the design system supplies the
    # values — so it runs on the mid tier. `edit-escalated` is the single retry
    # on the top tier when the mid tier returns nothing usable. Two roles rather
    # than one so record_usage attributes their cost separately and the
    # escalation rate is visible in the run log.
    "edit": "mid",
    "edit-escalated": "top",
}


def model_provider() -> str:
    return os.environ.get("ORCH_MODEL_PROVIDER", "anthropic")


def resolve_model(role: str) -> str:
    if role not in ROLE_TIERS:
        raise KeyError(
            f"unknown-role: {role!r} has no tier; known roles: {sorted(ROLE_TIERS)}"
        )
    tier = ROLE_TIERS[role]
    models = GEMINI_TIER_MODELS if model_provider() == "gemini" else TIER_MODELS
    return models[tier]


def runlog_dir() -> Path:
    return Path(os.environ.get("ORCHESTRATOR_RUNLOG_DIR", ORCHESTRATOR_ROOT / "runlog"))
