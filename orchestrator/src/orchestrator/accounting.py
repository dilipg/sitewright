"""Per-call token accounting (pipeline sections 3/7): one JSONL row per model
call. Rows are written by the model-call step itself, so a resumed run that
skips a completed checkpoint appends nothing — which is exactly what the
crash-resume verification asserts."""

import json
from datetime import datetime, timezone
from pathlib import Path

from orchestrator.config import runlog_dir


def default_log_path() -> Path:
    return runlog_dir() / "usage.jsonl"


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
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")


def read_usage(log_path: Path) -> list[dict]:
    path = Path(log_path)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
