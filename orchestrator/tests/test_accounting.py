"""Per-call token accounting: JSONL rows, readable back for assertions."""

from pathlib import Path

import pytest

from orchestrator.accounting import default_log_path, read_usage, record_usage


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


def test_record_usage_prices_the_row(tmp_path: Path) -> None:
    log = tmp_path / "usage.jsonl"
    record_usage(
        role="section",
        model="claude-sonnet-5",
        usage={
            "input_tokens": 1_000_000,
            "output_tokens": 0,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        },
        log_path=log,
    )
    row = read_usage(log)[0]
    assert row["cost_usd"] == pytest.approx(3.00)


def test_record_usage_leaves_an_unpriced_model_null_not_zero(tmp_path: Path) -> None:
    log = tmp_path / "usage.jsonl"
    record_usage(
        role="section",
        model="gemini-flash-latest",
        usage={"input_tokens": 10, "output_tokens": 10},
        log_path=log,
    )
    row = read_usage(log)[0]
    # None, never 0.0 — a zero reads as "this call was free", which would
    # silently understate a user's bill under the gemini escape hatch.
    assert row["cost_usd"] is None
    assert "cost_usd" in row


def test_default_log_path_honours_the_server_override(tmp_path: Path, monkeypatch) -> None:
    target = tmp_path / "nested" / "invocation.jsonl"
    monkeypatch.setenv("WEBGEN_USAGE_LOG", str(target))
    assert default_log_path() == target

    record_usage(role="edit", model="claude-sonnet-5", usage={"input_tokens": 1})
    assert target.exists()
    assert read_usage(target)[0]["role"] == "edit"


def test_default_log_path_ignores_an_empty_override(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("ORCHESTRATOR_RUNLOG_DIR", str(tmp_path))
    monkeypatch.setenv("WEBGEN_USAGE_LOG", "")
    # An empty value is an unset value, not a request to write to "".
    assert default_log_path() == tmp_path / "usage.jsonl"
