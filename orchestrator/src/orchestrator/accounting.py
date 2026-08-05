"""Per-call token accounting (pipeline sections 3/7): one JSONL row per model
call. Rows are written by the model-call step itself, so a resumed run that
skips a completed checkpoint appends nothing — which is exactly what the
crash-resume verification asserts."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

from orchestrator.config import runlog_dir
from orchestrator.pricing import PRICING_PER_TOKEN, usage_cost

#: Set by the hosted server (server/) to a per-invocation file, so the spend
#: of one request can be attributed to one user and ingested into usage_event.
#: Unset for every local CLI invocation, which keeps writing to the shared
#: runlog/usage.jsonl exactly as before.
USAGE_LOG_ENV_VAR = "WEBGEN_USAGE_LOG"


def default_log_path() -> Path:
    override = os.environ.get(USAGE_LOG_ENV_VAR)
    # Truthiness, not `is not None`: an empty value is an unset value. Path("")
    # resolves to the current directory, so treating it as a path would write
    # a *directory* name and raise IsADirectoryError deep inside a model call.
    if override:
        return Path(override)
    return runlog_dir() / "usage.jsonl"


def _cost_usd(model: str, usage: dict[str, int]) -> float | None:
    """None, never 0.0, for a model with no published rate — the same choice
    pricing.run_cost makes, and for the same reason: a zero reads as "free"
    and silently understates the bill."""
    if model not in PRICING_PER_TOKEN:
        return None
    return usage_cost(model, usage)


def record_usage(
    *,
    role: str,
    model: str,
    usage: dict[str, int],
    log_path: Path | None = None,
) -> None:
    path = Path(log_path) if log_path is not None else default_log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    row = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "role": role,
        "model": model,
        **usage,
        # After **usage, so a usage dict carrying its own cost_usd cannot
        # shadow the computed one.
        "cost_usd": _cost_usd(model, usage),
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def read_usage(log_path: Path) -> list[dict]:
    path = Path(log_path)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
