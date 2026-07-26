"""Per-call token accounting: JSONL rows, readable back for assertions."""

from pathlib import Path

from orchestrator.accounting import read_usage, record_usage


def test_records_and_reads_usage_rows(tmp_path: Path) -> None:
    log = tmp_path / "usage.jsonl"
    record_usage(
        log_path=log,
        role="page",
        model="claude-sonnet-5",
        usage={
            "input_tokens": 120,
            "output_tokens": 45,
            "cache_creation_input_tokens": 100,
            "cache_read_input_tokens": 0,
        },
    )
    record_usage(
        log_path=log,
        role="page",
        model="claude-sonnet-5",
        usage={
            "input_tokens": 20,
            "output_tokens": 50,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 100,
        },
    )

    rows = read_usage(log)
    assert len(rows) == 2
    assert rows[0]["role"] == "page"
    assert rows[0]["input_tokens"] == 120
    assert rows[1]["cache_read_input_tokens"] == 100
    assert all("timestamp" in row for row in rows)


def test_read_usage_of_missing_file_is_empty(tmp_path: Path) -> None:
    assert read_usage(tmp_path / "absent.jsonl") == []
