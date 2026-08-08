"""Pure parts of the model-call step, plus the 2026-08-06 transport-retry
decision: retry ONLY a connection error/timeout/429/5xx, never a call that
completed and whose output a gate later rejected, capped at 2 attempts
total (the original plus one retry), logged through the run log.

pytest stays offline throughout. Two different faking strategies, on
purpose:
- anthropic: `_anthropic_client` CONFIGURES the real SDK's own retry loop
  rather than wrapping it (see model_call.py's module docstring for the
  empirical check that established this). So these tests fake the
  TRANSPORT only (`httpx.MockTransport`) and run a REAL `anthropic.Anthropic`
  against it -- proving the actual configured retry behaviour, not a
  hand-rolled substitute for it.
- gemini: the SDK does not retry transport failures by default, so
  `_call_gemini_with_retry` is this file's own code. Its tests fake a
  plain callable and, for the one end-to-end test, a fake `genai.Client`
  -- there is no SDK retry loop to prove here, only ours.
"""

import types
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path

import httpx
import pytest

import orchestrator.model_call as model_call
from orchestrator.model_call import (
    TOTAL_ATTEMPTS,
    _anthropic_client,
    _call_gemini_with_retry,
    _gemini_retry_after_s,
    _is_gemini_transport_failure,
    build_cached_system,
    call_model,
)
from orchestrator.runlog import read_run_events


def test_system_block_carries_cache_control() -> None:
    blocks = build_cached_system("You are a page agent.")
    assert blocks == [
        {
            "type": "text",
            "text": "You are a page agent.",
            "cache_control": {"type": "ephemeral"},
        }
    ]


# ---------- shared test doubles: a fake transport under the real anthropic SDK ----------


def _message_response(*, status_code: int = 200, headers: dict | None = None, text: str = "hello") -> httpx.Response:
    body = {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": "claude-sonnet-5",
        "content": [{"type": "text", "text": text}],
        "usage": {"input_tokens": 10, "output_tokens": 5},
    }
    return httpx.Response(status_code, json=body, headers=headers or {})


def _error_response(status_code: int, *, headers: dict | None = None, error_type: str = "overloaded_error") -> httpx.Response:
    body = {"type": "error", "error": {"type": error_type, "message": "synthetic failure"}}
    return httpx.Response(status_code, json=body, headers=headers or {})


def _queued_transport(responses: list[httpx.Response]) -> tuple[httpx.MockTransport, list[httpx.Request]]:
    """Hands back the given responses in order, one per HTTP attempt, so
    the real `anthropic.Anthropic` client's own retry loop runs unmodified
    against it. Records each request so tests can assert attempt counts."""
    queue = list(responses)
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return queue.pop(0)

    return httpx.MockTransport(handler), calls


def _fake_anthropic_factory(transport: httpx.MockTransport):
    """Stands in for `orchestrator.model_call.Anthropic`: forwards
    `max_retries`/`middleware` -- the two things `_anthropic_client`
    configures -- into a REAL `anthropic.Anthropic`, wired to the fake
    transport instead of the network."""
    import anthropic as anthropic_pkg

    def factory(*, max_retries: int, middleware: list) -> "anthropic_pkg.Anthropic":
        return anthropic_pkg.Anthropic(
            api_key="test-key",
            http_client=httpx.Client(transport=transport),
            max_retries=max_retries,
            middleware=middleware,
        )

    return factory


def _patch_anthropic_transport(
    monkeypatch: pytest.MonkeyPatch, responses: list[httpx.Response]
) -> tuple[list[httpx.Request], list[float]]:
    transport, calls = _queued_transport(responses)
    monkeypatch.setattr(model_call, "Anthropic", _fake_anthropic_factory(transport))
    # the real SDK's own backoff sleep -- captured instead of actually
    # waited out, so these tests stay fast and the Retry-After test can
    # assert against the exact duration the SDK chose to sleep
    sleeps: list[float] = []
    monkeypatch.setattr("anthropic._base_client.time.sleep", sleeps.append)
    return calls, sleeps


# ---------- anthropic: the SDK's own retry loop, configured not wrapped ----------


def test_anthropic_client_caps_total_attempts_at_two(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    client = _anthropic_client(role="page", call="messages.create", log_path=Path("unused.jsonl"))
    # max_retries=1 -> the SDK's own loop runs range(max_retries + 1) == 2
    # attempts total (anthropic/_base_client.py). Pinned as a literal, not
    # compared against TOTAL_ATTEMPTS -- so a change to that constant's
    # *value* (not just a divergence between it and this call site) still
    # fails a test, per the 2026-08-06 decision that the count is fixed.
    assert client.max_retries == 1
    assert TOTAL_ATTEMPTS == 2


def test_anthropic_client_installs_retry_logging_middleware(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    client = _anthropic_client(role="page", call="messages.create", log_path=Path("unused.jsonl"))
    assert len(client.middleware) == 1
    assert isinstance(client.middleware[0], model_call._RetryLogger)


def test_529_then_success_retries_once_and_records_usage_once(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls, _sleeps = _patch_anthropic_transport(monkeypatch, [_error_response(529), _message_response(text="ok")])
    usage_calls: list[dict] = []
    monkeypatch.setattr(model_call, "record_usage", lambda **kw: usage_calls.append(kw))

    result = call_model(role="page", system="sys", user="hi", log_path=tmp_path / "retries.jsonl")

    assert result["text"] == "ok"
    assert len(calls) == 2
    assert len(usage_calls) == 1


def test_400_is_not_retried(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls, _sleeps = _patch_anthropic_transport(
        monkeypatch, [_error_response(400, error_type="invalid_request_error")]
    )
    usage_calls: list[dict] = []
    monkeypatch.setattr(model_call, "record_usage", lambda **kw: usage_calls.append(kw))

    with pytest.raises(Exception):
        call_model(role="page", system="sys", user="hi", log_path=tmp_path / "retries.jsonl")

    assert len(calls) == 1
    assert usage_calls == []


def test_two_consecutive_failures_raise(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls, _sleeps = _patch_anthropic_transport(monkeypatch, [_error_response(529), _error_response(529)])
    usage_calls: list[dict] = []
    monkeypatch.setattr(model_call, "record_usage", lambda **kw: usage_calls.append(kw))

    with pytest.raises(Exception):
        call_model(role="page", system="sys", user="hi", log_path=tmp_path / "retries.jsonl")

    # Literal 2, not TOTAL_ATTEMPTS -- so a change to the constant's value
    # itself (not just a call site drifting from it) still fails this test.
    assert len(calls) == 2
    assert usage_calls == []


def test_anthropic_retry_after_header_is_honoured(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls, sleeps = _patch_anthropic_transport(
        monkeypatch, [_error_response(529, headers={"retry-after": "2"}), _message_response()]
    )
    monkeypatch.setattr(model_call, "record_usage", lambda **kw: None)

    call_model(role="page", system="sys", user="hi", log_path=tmp_path / "retries.jsonl")

    assert len(calls) == 2
    assert sleeps == [pytest.approx(2.0)]


def test_anthropic_retry_is_logged_through_the_run_log(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _patch_anthropic_transport(monkeypatch, [_error_response(529), _message_response()])
    monkeypatch.setattr(model_call, "record_usage", lambda **kw: None)
    log_path = tmp_path / "retries.jsonl"

    call_model(role="page", system="sys", user="hi", log_path=log_path)

    events = read_run_events(log_path)
    assert len(events) == 1
    assert events[0]["event_type"] == "model_call.retried"
    assert events[0]["provider"] == "anthropic"
    assert events[0]["role"] == "page"


def test_anthropic_success_on_first_attempt_logs_nothing(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    _patch_anthropic_transport(monkeypatch, [_message_response()])
    monkeypatch.setattr(model_call, "record_usage", lambda **kw: None)
    log_path = tmp_path / "retries.jsonl"

    call_model(role="page", system="sys", user="hi", log_path=log_path)

    assert read_run_events(log_path) == []


def test_structured_path_uses_the_shared_anthropic_client_builder(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """`_call_anthropic_structured` -- the path every real page/section/
    shell/design/plan/edit call actually goes through -- must build its
    client through `_anthropic_client`, the one place the 2-attempt cap
    and retry logging are configured, rather than constructing its own."""
    fake_message = types.SimpleNamespace(
        content=[types.SimpleNamespace(type="tool_use", input={"ok": True})],
        usage=types.SimpleNamespace(
            input_tokens=1, output_tokens=1, cache_creation_input_tokens=0, cache_read_input_tokens=0
        ),
    )

    class _FakeStream:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get_final_message(self):
            return fake_message

    class _FakeMessages:
        def stream(self, **kwargs):
            return _FakeStream()

    class _FakeClient:
        def __init__(self):
            self.messages = _FakeMessages()

    captured: dict = {}

    def fake_builder(*, role: str, call: str, log_path: Path):
        captured["role"] = role
        captured["call"] = call
        captured["log_path"] = log_path
        return _FakeClient()

    def _poisoned_anthropic(**kwargs):
        raise AssertionError(
            "orchestrator.model_call.Anthropic constructed directly -- "
            "_call_anthropic_structured must go through _anthropic_client instead. "
            "(Poisoned so a regression here fails fast/offline rather than making a real API call.)"
        )

    monkeypatch.setattr(model_call, "Anthropic", _poisoned_anthropic)
    monkeypatch.setattr(model_call, "_anthropic_client", fake_builder)
    monkeypatch.setattr(model_call, "record_usage", lambda **kw: None)

    result = model_call._call_anthropic_structured(
        role="page",
        system="sys",
        user="hi",
        tool_name="emit",
        tool_description="d",
        tool_schema={"type": "object"},
        max_tokens=100,
        log_path=tmp_path / "retries.jsonl",
    )

    assert result["data"] == {"ok": True}
    assert captured["role"] == "page"
    assert captured["call"] == "messages.stream"


# ---------- gemini: this file's own retry loop (the SDK does not retry by default) ----------


class _FakeGeminiHeaders:
    def __init__(self, headers: dict | None):
        self._headers = headers or {}

    def get(self, key: str):
        return self._headers.get(key)


class _FakeGeminiHttpResponse:
    def __init__(self, headers: dict | None = None):
        self.headers = _FakeGeminiHeaders(headers)


def _gemini_api_error(code: int, *, headers: dict | None = None):
    from google.genai import errors as genai_errors

    return genai_errors.APIError(
        code,
        {"error": {"message": "synthetic failure", "status": "SYNTHETIC"}},
        _FakeGeminiHttpResponse(headers),
    )


@pytest.mark.parametrize(
    ("make_exc", "expected"),
    [
        (lambda: _gemini_api_error(503), True),
        (lambda: _gemini_api_error(429), True),
        (lambda: _gemini_api_error(500), True),
        (lambda: _gemini_api_error(400), False),
        (lambda: _gemini_api_error(401), False),
        (lambda: _gemini_api_error(404), False),
        (lambda: httpx.ConnectError("boom"), True),
        (lambda: httpx.ReadTimeout("boom"), True),
        (lambda: ValueError("not a transport failure at all"), False),
    ],
)
def test_is_gemini_transport_failure_classifies_correctly(make_exc, expected: bool) -> None:
    assert _is_gemini_transport_failure(make_exc()) is expected


def test_gemini_retry_after_seconds_header_is_honoured() -> None:
    exc = _gemini_api_error(503, headers={"retry-after": "4"})
    assert _gemini_retry_after_s(exc) == pytest.approx(4.0)


def test_gemini_retry_after_http_date_is_honoured() -> None:
    future = datetime.now(timezone.utc) + timedelta(seconds=10)
    exc = _gemini_api_error(503, headers={"retry-after": format_datetime(future, usegmt=True)})
    wait_s = _gemini_retry_after_s(exc)
    assert wait_s is not None
    assert 8.0 < wait_s <= 10.5


def test_gemini_retry_after_absent_falls_back_to_none() -> None:
    exc = _gemini_api_error(503)
    assert _gemini_retry_after_s(exc) is None


def test_gemini_503_then_success_retries_once(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[int] = []

    def fn():
        calls.append(1)
        if len(calls) == 1:
            raise _gemini_api_error(503)
        return "ok"

    monkeypatch.setattr(model_call.time, "sleep", lambda s: None)
    log_path = tmp_path / "retries.jsonl"

    result = _call_gemini_with_retry(fn, role="page", log_path=log_path)

    assert result == "ok"
    assert len(calls) == 2
    events = read_run_events(log_path)
    assert len(events) == 1
    assert events[0]["event_type"] == "model_call.retried"
    assert events[0]["provider"] == "gemini"
    assert events[0]["role"] == "page"


def test_gemini_400_is_not_retried(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[int] = []

    def fn():
        calls.append(1)
        raise _gemini_api_error(400)

    with pytest.raises(Exception):
        _call_gemini_with_retry(fn, role="page", log_path=tmp_path / "retries.jsonl")

    assert len(calls) == 1


def test_gemini_two_consecutive_failures_raise(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[int] = []

    def fn():
        calls.append(1)
        raise _gemini_api_error(503)

    monkeypatch.setattr(model_call.time, "sleep", lambda s: None)

    with pytest.raises(Exception):
        _call_gemini_with_retry(fn, role="page", log_path=tmp_path / "retries.jsonl")

    # Literal 2, not TOTAL_ATTEMPTS -- see the anthropic-side test's comment.
    assert len(calls) == 2


def test_gemini_retry_after_is_honoured_in_the_wait(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    calls: list[int] = []

    def fn():
        calls.append(1)
        if len(calls) == 1:
            raise _gemini_api_error(503, headers={"retry-after": "3"})
        return "ok"

    sleeps: list[float] = []
    monkeypatch.setattr(model_call.time, "sleep", sleeps.append)

    _call_gemini_with_retry(fn, role="page", log_path=tmp_path / "retries.jsonl")

    assert sleeps == [pytest.approx(3.0)]


class _FakeGeminiUsageMetadata:
    def __init__(self):
        self.prompt_token_count = 10
        self.candidates_token_count = 5
        self.cached_content_token_count = 0


class _FakeGeminiResponse:
    def __init__(self):
        self.parsed = {"ok": True}
        self.text = '{"ok": true}'
        self.usage_metadata = _FakeGeminiUsageMetadata()


class _FakeGeminiModels:
    def __init__(self, fail_first_n: int):
        self.calls = 0
        self._fail_first_n = fail_first_n

    def generate_content(self, **kwargs):
        self.calls += 1
        if self.calls <= self._fail_first_n:
            raise _gemini_api_error(503)
        return _FakeGeminiResponse()


class _FakeGeminiClient:
    def __init__(self, models: _FakeGeminiModels):
        self.models = models


def test_gemini_structured_path_retries_once_and_records_usage_once(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """End-to-end through `_call_gemini_structured`: proves the wrapper is
    actually wired in (not just correct in isolation) and that a retried
    call still records usage exactly once."""
    fake_models = _FakeGeminiModels(fail_first_n=1)
    monkeypatch.setattr("google.genai.Client", lambda api_key: _FakeGeminiClient(fake_models))
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setattr(model_call.time, "sleep", lambda s: None)
    usage_calls: list[dict] = []
    monkeypatch.setattr(model_call, "record_usage", lambda **kw: usage_calls.append(kw))

    result = model_call._call_gemini_structured(
        role="page",
        system="sys",
        user="hi",
        tool_name="emit",
        tool_schema={"type": "object"},
        max_tokens=100,
        log_path=tmp_path / "retries.jsonl",
    )

    assert result["data"] == {"ok": True}
    assert fake_models.calls == 2
    assert len(usage_calls) == 1


# ---------- shared: default retry-log path ----------


def test_default_retry_log_path_lives_under_the_runlog_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("ORCHESTRATOR_RUNLOG_DIR", str(tmp_path))
    assert model_call.default_retry_log_path() == tmp_path / model_call.DEFAULT_RETRY_LOG_FILENAME
