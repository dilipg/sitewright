"""F3: a placeholder brand name must never reach the handover export.

Round 1's live verification (docs/reports/m8-live-verification.md) found every
generated site shipping `<title>&lt;UNKNOWN&gt;</title>` and `"name": "unknown"`
while the generated nav showed a real invented name. Intake emitted the literal
`"<UNKNOWN>"` for a brief that named no brand, and `shell_pipeline`'s
`brand_scaffold` faithfully wrote it into `index.html` and, via `brand_slug`,
into package.json.

These tests pin the deterministic backstop. The prompt/schema guidance added
alongside it is what should normally prevent the case; this is what makes
shipping impossible when a model ignores it.
"""

import pytest

from orchestrator.plan_pipeline import assert_brand_name_usable
from orchestrator.shell_pipeline import brand_slug


class TestRejectsPlaceholders:
    def test_rejects_the_exact_value_observed_live(self) -> None:
        with pytest.raises(ValueError, match="angle brackets"):
            assert_brand_name_usable("<UNKNOWN>")

    @pytest.mark.parametrize(
        "name",
        ["UNKNOWN", "unknown", "  Unknown  ", "TBD", "n/a", "N/A", "placeholder",
         "the brand", "Your Brand", "Company Name", "untitled", "none", "null", ""],
    )
    def test_rejects_placeholder_spellings(self, name: str) -> None:
        with pytest.raises(ValueError):
            assert_brand_name_usable(name)

    def test_rejects_any_angle_brackets_whatever_they_contain(self) -> None:
        # The shape is the tell; the contents are irrelevant. No real brand
        # name carries angle brackets.
        with pytest.raises(ValueError, match="angle brackets"):
            assert_brand_name_usable("<the coffee people>")

    def test_rejects_a_non_string(self) -> None:
        with pytest.raises(ValueError, match="must be a string"):
            assert_brand_name_usable(None)


class TestAcceptsRealNames:
    @pytest.mark.parametrize(
        "name",
        [
            "Artisan Roasters",          # what the generated nav actually showed
            "Acme Analytics",            # the fixture's own name: legitimate, not a placeholder
            "Acme",
            "Brandywine Books",          # contains "brand" as a substring
            "Company of Thieves",        # contains "company" as a substring
            "Unknown Pleasures Records", # contains "unknown" as a substring
            "NA Beverages",              # starts with the "na" spelling
            "Site Reliability Guild",
        ],
    )
    def test_accepts_plausible_brand_names(self, name: str) -> None:
        assert_brand_name_usable(name)

    def test_substring_matches_are_not_rejected(self) -> None:
        # The check is whole-string, not substring: rejecting anything merely
        # CONTAINING "brand" or "unknown" would refuse legitimate names, which
        # would turn a handover-quality guard into a generation-blocking bug.
        assert_brand_name_usable("Brandywine Books")
        assert_brand_name_usable("Unknown Pleasures Records")


class TestWhyItMatters:
    def test_the_rejected_value_is_exactly_what_produced_the_shipped_defect(self) -> None:
        # brand_slug is what turned "<UNKNOWN>" into package.json's "unknown",
        # so this pins the causal link the guard exists to break rather than
        # just asserting the guard fires.
        assert brand_slug("<UNKNOWN>") == "unknown"
        with pytest.raises(ValueError):
            assert_brand_name_usable("<UNKNOWN>")


class TestTheGuardIsActuallyWired:
    """The tests above exercise the function; these prove it is CALLED.

    Without this, deleting the call in `intake_step` would leave the whole
    suite green while the defect shipped again -- the function would be
    perfectly tested and perfectly inert.
    """

    def _intake_returning(self, monkeypatch, brand_name):
        from orchestrator import plan_pipeline

        def fake_call(**kwargs):
            return {
                "data": {"brief": {"brand": {"name": brand_name, "tone": "warm",
                                             "audience": "everyone", "oneLiner": "x"}}},
                "model": "fake-model",
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "duration_s": 0.0,
            }

        monkeypatch.setattr(plan_pipeline, "call_model_structured_impl", fake_call)
        return plan_pipeline

    def test_intake_step_raises_on_a_placeholder_from_the_model(self, monkeypatch, tmp_path) -> None:
        pp = self._intake_returning(monkeypatch, "<UNKNOWN>")
        monkeypatch.setattr(pp, "default_run_log_path", lambda run_id: tmp_path / f"{run_id}.jsonl")

        with pytest.raises(ValueError, match="angle brackets"):
            pp.intake_step.__wrapped__("run-1", "a site for a coffee roaster", "")

    def test_intake_step_passes_a_real_name_through(self, monkeypatch, tmp_path) -> None:
        pp = self._intake_returning(monkeypatch, "Artisan Roasters")
        monkeypatch.setattr(pp, "default_run_log_path", lambda run_id: tmp_path / f"{run_id}.jsonl")

        out = pp.intake_step.__wrapped__("run-2", "a site for a coffee roaster", "")
        assert out["brief"]["brand"]["name"] == "Artisan Roasters"

    def test_a_clarifying_questions_response_is_not_rejected_for_having_no_brand(
        self, monkeypatch, tmp_path
    ) -> None:
        # Intake may legitimately return questions instead of a brief; that
        # response carries no brand at all and must not trip the guard.
        from orchestrator import plan_pipeline as pp

        monkeypatch.setattr(
            pp,
            "call_model_structured_impl",
            lambda **kw: {
                "data": {"clarifyingQuestions": ["What is this site for?"]},
                "model": "fake-model",
                "usage": {"input_tokens": 1, "output_tokens": 1},
                "duration_s": 0.0,
            },
        )
        monkeypatch.setattr(pp, "default_run_log_path", lambda run_id: tmp_path / f"{run_id}.jsonl")

        out = pp.intake_step.__wrapped__("run-3", "thin", "")
        assert "clarifyingQuestions" in out

    def test_the_raw_output_is_on_the_record_before_the_raise(self, monkeypatch, tmp_path) -> None:
        # A refused brand name must be diagnosable from the run log, so the
        # append happens BEFORE the validation. If that order were reversed the
        # failure would be invisible.
        pp = self._intake_returning(monkeypatch, "<UNKNOWN>")
        log = tmp_path / "run-4.jsonl"
        monkeypatch.setattr(pp, "default_run_log_path", lambda run_id: log)

        with pytest.raises(ValueError):
            pp.intake_step.__wrapped__("run-4", "brief", "")

        assert log.exists(), "the intake.complete event must be logged before the raise"
        assert "<UNKNOWN>" in log.read_text(encoding="utf-8")
