"""Suite-wide safety net for "pytest stays offline" (the 2026-08-06
transport-retry decision's own constraint, generalized here after the
task-6 review process caught it being satisfied only per-test rather than
suite-wide -- see task-6-report.md).

Without this, a production regression that bypasses a test's own local
fake (e.g. `_call_anthropic_structured` reverting to a bare `Anthropic()`
instead of going through `_anthropic_client`) can construct a REAL SDK
client. If a real API key happens to be present in the environment (as
`orchestrator/.env` genuinely does in local dev -- `config.py` module-scope
`load_dotenv`s it on import), that real client can make a real, billed
network call before the test's assertions ever get a chance to fail it.
This happened once, during this task's own perturbation exercise.

The fix is structural, not a discipline reminder: every test gets both
providers' client CONSTRUCTORS poisoned by default, before its body runs.
A test that genuinely needs a working client (wired to a fake transport,
or a hand-built fake client) opts back in explicitly, in its own body, by
monkeypatching the constructor again -- exactly the pattern
`test_model_call.py`'s existing fakes already use. `monkeypatch`'s own
teardown makes this per-test and automatically reverted; nothing here
needs to be cleaned up by hand.

Scoped to the two actual, confirmed construction points in production
code (both single-sourced by design):
- `orchestrator.model_call.Anthropic` -- `orchestrator/src/orchestrator/
  model_call.py`'s `_anthropic_client` is documented as "the one place an
  `Anthropic` client is constructed"; `model_call.py` imports it via
  `from anthropic import Anthropic`, a bound name in that module's own
  namespace, so the poison targets that name specifically rather than
  `anthropic.Anthropic` at the source (patching the source would not
  intercept `model_call.py`'s already-bound reference to it).
- `google.genai.Client` -- `_call_gemini_structured` always reaches it via
  `from google import genai; genai.Client(...)`, a plain attribute lookup
  on the `google.genai` module at call time, so patching the source
  attribute correctly intercepts every current (and, unlike the anthropic
  case, future) caller that follows the same pattern.

Verified before adding this: no test file other than test_model_call.py
constructs a real client of either kind (test_edit_agent.py monkeypatches
`call_model_structured_impl` itself, one layer up, so it never reaches
client construction at all) -- so this fixture perturbs nothing that
passes today.
"""

import pytest


class LiveModelClientBlocked(AssertionError):
    """Raised instead of letting a real SDK client be constructed during a
    test. A network attempt during the test suite is always a bug, never a
    legitimate outcome -- pytest must stay offline."""


@pytest.fixture(autouse=True)
def _block_live_model_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    def _poisoned_anthropic(*args, **kwargs):
        raise LiveModelClientBlocked(
            "A real anthropic.Anthropic client was about to be constructed during a "
            "test. pytest must stay offline (2026-08-06 retry decision). If this test "
            "genuinely needs one, monkeypatch orchestrator.model_call.Anthropic back "
            "explicitly in the test body, wired to a fake transport (httpx.MockTransport) "
            "-- see test_model_call.py's _fake_anthropic_factory."
        )

    def _poisoned_gemini_client(*args, **kwargs):
        raise LiveModelClientBlocked(
            "A real google.genai.Client was about to be constructed during a test. "
            "pytest must stay offline (2026-08-06 retry decision). If this test "
            "genuinely needs one, monkeypatch google.genai.Client back explicitly in "
            "the test body, wired to a fake -- see test_model_call.py's "
            "_FakeGeminiClient / _FakeGeminiModels."
        )

    monkeypatch.setattr("orchestrator.model_call.Anthropic", _poisoned_anthropic)
    monkeypatch.setattr("google.genai.Client", _poisoned_gemini_client)
