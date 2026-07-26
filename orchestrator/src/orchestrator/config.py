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

ROLE_TIERS: dict[str, str] = {
    "intake": "mid",
    "planner": "mid",
    "design-system": "top",
    "shell": "mid",
    "page": "top",
    "export-cleanup": "small",
}


def resolve_model(role: str) -> str:
    if role not in ROLE_TIERS:
        raise KeyError(
            f"unknown-role: {role!r} has no tier; known roles: {sorted(ROLE_TIERS)}"
        )
    return TIER_MODELS[ROLE_TIERS[role]]


def runlog_dir() -> Path:
    return Path(os.environ.get("ORCHESTRATOR_RUNLOG_DIR", ORCHESTRATOR_ROOT / "runlog"))
