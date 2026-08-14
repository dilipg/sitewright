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

import re

import pytest

from orchestrator.config import ORCHESTRATOR_ROOT
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


class TestTheReadmeAgreesWithTheCode:
    """The README described BOTH defaults at once, in the two halves two
    different people last touched: the Docker half said unset means serial (true),
    while the from-source half said "unset means one worker per route at once …
    and is the setting the wall-clock figures were measured under" (false on both
    counts once the default flipped). A contributor reading the from-source path
    got the wrong model of the default and an untrue provenance for the timings.

    No test could have caught that, because nothing in the suite reads the README.
    This does. It is intentionally narrow — a claim about the UNSET default, whose
    truth `max_parallel_workers()` decides — rather than a prose linter.
    """

    README = ORCHESTRATOR_ROOT.parent / "README.md"

    def test_the_readme_exists_where_this_looks_for_it(self) -> None:
        # premise guard: a moved README would make everything below vacuous
        assert self.README.is_file()

    def test_no_half_of_the_readme_claims_unset_means_parallel(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("WEBGEN_FANOUT_MAX_WORKERS", raising=False)
        assert max_parallel_workers() == 1, "premise: the default really is serial"

        text = self.README.read_text(encoding="utf-8")
        for claim in ("one worker per route at once", "fan-out is **uncapped**"):
            assert claim not in text, (
                f"README still claims {claim!r}, but WEBGEN_FANOUT_MAX_WORKERS unset "
                f"means {max_parallel_workers()} worker(s)."
            )

    def test_every_mention_of_the_variable_sits_near_the_word_serial(self) -> None:
        """Each place the variable is named must carry the default it actually
        has. Checked per mention, because the defect was one mention out of three
        being stale, not the file lacking the word."""
        text = self.README.read_text(encoding="utf-8")
        mentions = [m.start() for m in re.finditer(r"WEBGEN_FANOUT_MAX_WORKERS", text)]
        assert len(mentions) >= 3, mentions  # RAM row, Docker note, from-source step
        for start in mentions:
            window = text[max(0, start - 600) : start + 600]
            assert "serial" in window, text[max(0, start - 200) : start + 200]
