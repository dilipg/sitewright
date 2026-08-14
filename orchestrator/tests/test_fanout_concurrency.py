"""Fan-out is serial by default, because parallel fan-out corrupts a run.

Measured in a dogfood run through Docker: two page workers started 424 ms apart,
and Kitaru's metadata store is SQLite at ``journal_mode=delete`` (a rollback
journal — writers block each other) with ``busy_timeout=5000``. Verified directly
against the real store file. The earlier worker finished ``generate_section`` and
``write_section_only`` and then **never got a ``commit_section_manifest`` row**:
a SQLAlchemy ``OperationalError`` whose own failure-record write hit the same
lock.

That leaves a section's ``.tsx`` on disk with no ``manifest.json`` entry — exactly
what gate 4 rejects. The canvas shows a polished site; the export fails forever
and no retry can fix it, because the loss already happened upstream.

The default is therefore 1. Raising it restores the old parallel behaviour and
reopens the race, which is a choice a caller may make explicitly but must not
inherit by accident.
"""

from __future__ import annotations

import pytest

from orchestrator.fanout import max_parallel_workers


class TestDefaultIsSerial:
    def test_unset_means_one_worker(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # The whole point. Before this, unset meant "all at once" (1_000_000),
        # which is the configuration that corrupted a run.
        monkeypatch.delenv("WEBGEN_FANOUT_MAX_WORKERS", raising=False)
        assert max_parallel_workers() == 1

    def test_empty_and_whitespace_also_mean_serial(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # An env var set to "" by a shell or a compose file must not read as
        # "unbounded" — that is the same silent-default hazard, one layer out.
        for value in ("", "   "):
            monkeypatch.setenv("WEBGEN_FANOUT_MAX_WORKERS", value)
            assert max_parallel_workers() == 1


class TestExplicitOptIn:
    def test_a_caller_can_still_choose_parallelism(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Raising it is allowed: it is how the pre-dogfood behaviour comes back,
        # for anyone who accepts the race until Kitaru's store is WAL (K1).
        monkeypatch.setenv("WEBGEN_FANOUT_MAX_WORKERS", "4")
        assert max_parallel_workers() == 4

    @pytest.mark.parametrize("bad", ["0", "-1", "two", "1.5", "0x2", "1e3"])
    def test_refuses_a_bad_value_rather_than_clamping(
        self, monkeypatch: pytest.MonkeyPatch, bad: str
    ) -> None:
        # Refuse, never clamp — the same call `loadMasterKey` and
        # `shutdown-budget.ts` make. A silently-ignored limit produces a
        # concurrency nobody chose, and its failure surfaces minutes later as a
        # worker dying with no output, or as this corruption.
        monkeypatch.setenv("WEBGEN_FANOUT_MAX_WORKERS", bad)
        with pytest.raises(ValueError):
            max_parallel_workers()
