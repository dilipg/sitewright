"""Run log v1 (pipeline section 7, build-plan stub table): JSONL events plus
a dumb HTML viewer (orchestrator/runlog-viewer.html). Every model call logs
its rendered prompt (hash + stored text), template version, model, params,
token counts; gate results and checkpoint refs land as separate events.
Without this, dynamic-context prompts are undebuggable."""

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from orchestrator.config import runlog_dir


def default_run_log_path(run_id: str) -> Path:
    return runlog_dir() / f"{run_id}.jsonl"


def append_run_event(
    log_path: Path,
    *,
    event_type: str,
    run_id: str | None = None,
    **fields: Any,
) -> None:
    path = Path(log_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "run_id": run_id,
        "event_type": event_type,
        **fields,
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event) + "\n")


def read_run_events(log_path: Path) -> list[dict]:
    path = Path(log_path)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
