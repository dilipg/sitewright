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

The fix is structural, not a discipline reminder, and it is TWO independent
layers on purpose (added in that order; the second closed a residual the
first round's own review process flagged):

1. Both providers' client CONSTRUCTORS are poisoned by default, before each
   test's body runs. A test that genuinely needs a working client (wired to
   a fake transport, or a hand-built fake client) opts back in explicitly,
   in its own body, by monkeypatching the constructor again -- exactly the
   pattern `test_model_call.py`'s existing fakes already use. Scoped to the
   two actual, confirmed construction points in production code (both
   single-sourced by design):
   - `orchestrator.model_call.Anthropic` -- `orchestrator/src/orchestrator/
     model_call.py`'s `_anthropic_client` is documented as "the one place an
     `Anthropic` client is constructed"; `model_call.py` imports it via
     `from anthropic import Anthropic`, a bound name in that module's own
     namespace, so the poison targets that name specifically rather than
     `anthropic.Anthropic` at the source (patching the source would not
     intercept `model_call.py`'s already-bound reference to it).
   - `google.genai.Client` -- `_call_gemini_structured` always reaches it
     via `from google import genai; genai.Client(...)`, a plain attribute
     lookup on the `google.genai` module at call time, so patching the
     source attribute correctly intercepts every current (and, unlike the
     anthropic case, future) caller that follows the same pattern.
   This layer gives a clear, early, legible failure with a useful message
   -- but its coverage is exactly the two symbols above, and someone has to
   remember to keep it in sync with any new construction path (a refactor
   to a different import binding, a third-party dependency building its own
   client). A bypass here is not hypothetical: this task's own perturbation
   exercise made one real, billed Anthropic API call before this layer
   existed.

2. Underneath that, `httpx.HTTPTransport.handle_request` and
   `httpx.AsyncHTTPTransport.handle_async_request` -- the methods that
   actually open a socket and send bytes -- are poisoned too, unconditionally,
   with no opt-out. This is what holds when layer 1's enumerated symbols
   don't cover the path: no matter how a real client gets constructed, if it
   uses a real (default) transport, sending a request raises before any byte
   leaves the process. Empirically verified this does NOT break any
   MockTransport-backed test: `httpx.MockTransport` (`httpx.MockTransport.__mro__`)
   extends `AsyncBaseTransport`/`BaseTransport` directly, NOT
   `HTTPTransport`/`AsyncHTTPTransport`, and defines its own
   `handle_request`/`handle_async_request` -- so patching the real
   transport's methods has zero effect on a client constructed with
   `http_client=httpx.Client(transport=httpx.MockTransport(...))`, which is
   how every fake-transport test in this suite is built. No opt-out is
   provided for this layer (unlike layer 1): a test that needs a real
   client fakes the TRANSPORT, never the actual network.

Verified before adding this: no test file other than test_model_call.py
constructs a real client of either kind (test_edit_agent.py monkeypatches
`call_model_structured_impl` itself, one layer up, so it never reaches
client construction at all) -- so this fixture perturbs nothing that
passes today. `monkeypatch`'s own teardown makes both layers per-test and
automatically reverted; nothing here needs to be cleaned up by hand.
"""

import httpx
import pytest


class LiveModelClientBlocked(AssertionError):
    """Raised instead of letting a real SDK client be constructed, or a
    real HTTP request be sent, during a test. A network attempt during the
    test suite is always a bug, never a legitimate outcome -- pytest must
    stay offline."""


@pytest.fixture(autouse=True)
def _block_live_model_clients(monkeypatch: pytest.MonkeyPatch) -> None:
    # ---- layer 1: known client constructors (clear message, opt-out-able) ----
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

    # ---- layer 2: the real transport itself (unconditional, no opt-out) ----
    def _poisoned_handle_request(self, request):
        raise LiveModelClientBlocked(
            "A real HTTP request was about to be sent during a test "
            "(httpx.HTTPTransport.handle_request). pytest must stay offline "
            "(2026-08-06 retry decision). Wire the client to httpx.MockTransport "
            "instead -- a different transport class, unaffected by this patch."
        )

    async def _poisoned_handle_async_request(self, request):
        raise LiveModelClientBlocked(
            "A real HTTP request was about to be sent during a test "
            "(httpx.AsyncHTTPTransport.handle_async_request). pytest must stay "
            "offline (2026-08-06 retry decision). Wire the client to "
            "httpx.MockTransport instead -- a different transport class, "
            "unaffected by this patch."
        )

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", _poisoned_handle_request)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", _poisoned_handle_async_request)
