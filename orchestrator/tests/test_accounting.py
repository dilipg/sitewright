"""Per-call token accounting: JSONL rows, readable back for assertions."""

import json
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


def test_record_usage_matches_the_shared_contract_golden_file(tmp_path: Path) -> None:
    """`fixtures/usage-log-contract.jsonl` (repo root) is the contract shared
    between this module's writer (`record_usage`) and
    `server/src/ingest-usage.ts`'s reader on the TypeScript side. The two were
    written from separate briefs and, before this test and its TypeScript
    counterpart in `ingest-usage.test.ts`, were never checked against each
    other at all — a change to the row shape here could silently turn 100% of
    a run's billing into `skipped` on the server side while both test suites
    stayed green.

    This half re-runs `record_usage` with the exact three inputs the golden
    file was generated from (a priced sonnet call with all four token fields
    non-zero, a priced haiku call, and an unpriced `gemini-flash-latest`
    call) and asserts the resulting rows' KEY SETS and value TYPES match the
    golden file's — not exact values, since a fresh timestamp and a float's
    repr are expected to differ run to run and are not part of the contract.

    Regenerating the golden file means re-running these same three calls
    through `record_usage`, writing the result (with `\\n` line endings) over
    `fixtures/usage-log-contract.jsonl`, and updating BOTH this test and
    `ingest-usage.test.ts`'s golden-file test to match the new shape.
    """
    log = tmp_path / "usage.jsonl"
    record_usage(
        role="section",
        model="claude-sonnet-5",
        usage={
            "input_tokens": 1200,
            "output_tokens": 340,
            "cache_creation_input_tokens": 500,
            "cache_read_input_tokens": 75,
        },
        log_path=log,
    )
    record_usage(
        role="page",
        model="claude-haiku-4-5-20251001",
        usage={
            "input_tokens": 800,
            "output_tokens": 150,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        },
        log_path=log,
    )
    record_usage(
        role="edit",
        model="gemini-flash-latest",
        usage={
            "input_tokens": 400,
            "output_tokens": 90,
            "cache_creation_input_tokens": 0,
            "cache_read_input_tokens": 0,
        },
        log_path=log,
    )
    fresh_rows = read_usage(log)

    golden_path = Path(__file__).resolve().parents[2] / "fixtures" / "usage-log-contract.jsonl"
    golden_rows = [
        json.loads(line)
        for line in golden_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]

    assert len(fresh_rows) == len(golden_rows) == 3
    for fresh, golden in zip(fresh_rows, golden_rows):
        assert set(fresh.keys()) == set(golden.keys())
        for key in golden:
            assert type(fresh[key]) is type(golden[key]), (
                f"{key!r} type mismatch: fresh={type(fresh[key])!r} golden={type(golden[key])!r}"
            )
