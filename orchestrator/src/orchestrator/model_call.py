"""The model call as a Kitaru checkpoint — the documented custom-step path
(kitaru.llm() does not yet support the structured output that page agents
need from 3.3). Prompt caching is enabled on Anthropic's system block from
day one (pipeline section 6 assumes it). Every real call records one
token-accounting row; replayed/skipped checkpoints record nothing.

Provider dispatch (ORCH_MODEL_PROVIDER=anthropic|gemini, default anthropic):
an OPT-IN escape hatch, not a target-architecture change — the contract
names the Claude API specifically (pipeline 5.1). Added to keep development
moving during an Anthropic billing-account outage (docs/decisions.md); the
default stays Anthropic and every other doc/prompt assumes it.

Transport-failure retry (2026-08-06 human decision, "at least one retry for
any failed LLM call"): a connection error, a timeout, a 429, or a 5xx means
no tokens were produced and nothing was billed, so retrying costs nothing —
a real 529 "Overloaded" killed a subagent during this project's own
development. That is categorically different from a call that COMPLETED
and whose output a gate then rejected; that path already has its own
bounded retry budget in the section pipeline, and re-running it bills
again. So this file never retries a non-429 4xx, and never wraps
`record_usage` — only the bare API call. Capped at 2 attempts total (the
original plus one retry) and not configurable, on purpose: a knob invites
someone to raise it, and retrying is exactly the mechanism a spend cap
exists to bound.

The two providers need this in different shapes, checked empirically
against the installed packages rather than assumed:
- anthropic (.venv/.../anthropic/_constants.py: DEFAULT_MAX_RETRIES = 2)
  already retries connection errors, timeouts, 429 and 5xx by default —
  3 attempts total, with its own exponential-backoff-with-jitter and
  Retry-After handling (`_base_client.py`'s `_calculate_retry_timeout`).
  `_anthropic_client` below CONFIGURES that down to 2 attempts total
  (`max_retries=1`) rather than wrapping it — wrapping an SDK that already
  retries would multiply into 2 outer x N inner attempts, exactly the
  unbounded behaviour this decision refuses.
- google-genai (.venv/.../google/genai/_api_client.py: `retry_args(None)`
  returns `{'stop': tenacity.stop_after_attempt(1), 'reraise': True}`, and
  `HttpOptions.retry_options` defaults to `None`) does NOT retry anything
  by default. Its opt-in `HttpRetryOptions` also has no Retry-After
  support at all, so it cannot reach this file's contract by configuration
  either. `_call_gemini_with_retry` below is therefore a real wrapper —
  the one this file's docstring otherwise argues against — written because
  the SDK leaves nothing to configure."""

import json
import os
import random
import time
from pathlib import Path

import httpx
from anthropic import Anthropic
from kitaru import checkpoint

from orchestrator.accounting import record_usage
from orchestrator.config import model_provider, resolve_model, runlog_dir
from orchestrator.runlog import append_run_event

#: Where a retried call is logged when no caller-specific path is given.
#: Deliberately NOT keyed by run_id (this file has no run_id in scope, and
#: threading one through every one of model_call's callers is out of this
#: task's stated scope) — a shared file, same idiom as
#: accounting.default_log_path()'s shared usage.jsonl.
DEFAULT_RETRY_LOG_FILENAME = "model-call-retries.jsonl"

#: 2 attempts total — the original plus one retry, per the 2026-08-06
#: decision ("at least 1"). Not configurable: a knob invites someone to
#: raise it.
TOTAL_ATTEMPTS = 2


def default_retry_log_path() -> Path:
    return runlog_dir() / DEFAULT_RETRY_LOG_FILENAME


def build_cached_system(text: str) -> list[dict]:
    """System block with a prompt-cache breakpoint: identical across all
    sections of a run, the largest single caching win (pipeline section 6)."""
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]


class _RetryLogger:
    """Anthropic-SDK middleware (`Anthropic(middleware=[...])`, a
    first-class, documented extension point — not a private hook): runs
    once per HTTP attempt, INSIDE the SDK's own retry loop.
    `request.retries_taken > 0` means this attempt exists only because a
    previous one failed for THIS call — exactly "a retry" — so logging on
    that condition makes a retried call visible in the run log rather than
    merely slower. The SDK owns the backoff/jitter/Retry-After mechanics
    (`_calculate_retry_timeout`); this only observes and logs."""

    def __init__(self, *, role: str, call: str, log_path: Path):
        self._role = role
        self._call = call
        self._log_path = log_path

    def __call__(self, request, call_next):
        if request.retries_taken > 0:
            append_run_event(
                self._log_path,
                event_type="model_call.retried",
                provider="anthropic",
                role=self._role,
                call=self._call,
                retry_number=request.retries_taken,
            )
        return call_next(request)


def _anthropic_client(*, role: str, call: str, log_path: Path) -> Anthropic:
    """The one place an `Anthropic` client is constructed. `max_retries`
    narrows the SDK's own default (2 -> 3 total attempts) down to exactly
    the 2 total attempts this file's decision calls for; `middleware`
    makes a retry visible in the run log. This CONFIGURES the SDK's
    existing retry loop (connection errors, timeouts, 429, 5xx; backoff
    with jitter; Retry-After) — it does not add a second one."""
    return Anthropic(
        max_retries=TOTAL_ATTEMPTS - 1,
        middleware=[_RetryLogger(role=role, call=call, log_path=log_path)],
    )


def call_model_structured_impl(
    *,
    role: str,
    system: str,
    user: str,
    tool_name: str,
    tool_description: str,
    tool_schema: dict,
    max_tokens: int = 8192,
    log_path: Path | None = None,
) -> dict:
    """Structured output, dispatched to the configured provider. Plain
    function: callers wrap it in their own checkpointed steps.

    Adds `duration_s`: the wall-clock latency of this one call. Run-log
    timestamps are written when a call COMPLETES, so without this a run
    report can only place a node in time, never show how long it took —
    and per-call latency is exactly what milestone 5.5 could not measure
    when fan-out missed its wall-clock target (docs/reports/m5-acceptance.md).
    Measured around the dispatch so it covers both providers (and, now,
    any retry wait inside it — a retried call genuinely did take longer).

    `log_path` is where a transport-failure retry gets logged; defaults to
    a shared file (see `default_retry_log_path`) so callers that don't
    have a run id in scope still get retry visibility."""
    resolved_log_path = log_path if log_path is not None else default_retry_log_path()
    started = time.perf_counter()
    if model_provider() == "gemini":
        result = _call_gemini_structured(
            role=role,
            system=system,
            user=user,
            tool_name=tool_name,
            tool_schema=tool_schema,
            max_tokens=max_tokens,
            log_path=resolved_log_path,
        )
    else:
        result = _call_anthropic_structured(
            role=role,
            system=system,
            user=user,
            tool_name=tool_name,
            tool_description=tool_description,
            tool_schema=tool_schema,
            max_tokens=max_tokens,
            log_path=resolved_log_path,
        )
    result["duration_s"] = round(time.perf_counter() - started, 3)
    return result


def _call_anthropic_structured(
    *,
    role: str,
    system: str,
    user: str,
    tool_name: str,
    tool_description: str,
    tool_schema: dict,
    max_tokens: int,
    log_path: Path,
) -> dict:
    """Structured output via a forced tool call: the response IS the tool
    input, schema-validated by the API — no JSON parsing of prose."""
    model = resolve_model(role)
    client = _anthropic_client(role=role, call="messages.stream", log_path=log_path)
    # streamed: large-output calls (e.g. the 15-primitive set) exceed the
    # SDK's non-streaming time guard; get_final_message() yields the same
    # Message object either way
    with client.messages.stream(
        model=model,
        max_tokens=max_tokens,
        system=build_cached_system(system),
        messages=[{"role": "user", "content": user}],
        tools=[{"name": tool_name, "description": tool_description, "input_schema": tool_schema}],
        tool_choice={"type": "tool", "name": tool_name},
    ) as stream:
        response = stream.get_final_message()
    tool_use = next(block for block in response.content if block.type == "tool_use")
    usage = {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "cache_creation_input_tokens": getattr(response.usage, "cache_creation_input_tokens", 0) or 0,
        "cache_read_input_tokens": getattr(response.usage, "cache_read_input_tokens", 0) or 0,
    }
    record_usage(role=role, model=model, usage=usage)
    return {"data": tool_use.input, "model": model, "usage": usage}


def _is_gemini_transport_failure(exc: BaseException) -> bool:
    """Connection errors, timeouts, 429, and any 5xx — never a non-429
    4xx (a 400 is malformed and will fail identically forever; a 401 is a
    bad key). Deliberately narrower than the codes google-genai's own
    OPT-IN retry option would use by default (which includes 408) — this
    project's decision names exactly connection/timeout/429/5xx."""
    from google.genai import errors as genai_errors

    if isinstance(exc, (httpx.TimeoutException, httpx.ConnectError)):
        return True
    if isinstance(exc, genai_errors.APIError):
        code = exc.code
        return isinstance(code, int) and (code == 429 or 500 <= code < 600)
    return False


def _gemini_retry_after_s(exc: BaseException) -> float | None:
    """Honours a `Retry-After` header when the failed response carries
    one — seconds, or an HTTP-date, per RFC 9110. Returns None (fall back
    to computed backoff) when absent, unparsable, or non-positive."""
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None)
    if headers is None:
        return None
    value = headers.get("retry-after")
    if not value:
        return None
    try:
        seconds = float(value)
        return seconds if seconds > 0 else None
    except (TypeError, ValueError):
        pass
    try:
        from datetime import datetime, timezone
        from email.utils import parsedate_to_datetime

        when = parsedate_to_datetime(value)
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        seconds = (when - datetime.now(timezone.utc)).total_seconds()
        return seconds if seconds > 0 else None
    except (TypeError, ValueError, IndexError):
        return None


def _gemini_backoff_s(attempt_index: int) -> float:
    """Exponential backoff with jitter — same shape (0.5s initial, 8s cap,
    plus-or-minus jitter) as anthropic's own `_calculate_retry_timeout`,
    used only when the failure carried no `Retry-After`."""
    base = min(0.5 * (2**attempt_index), 8.0)
    jitter = 1 - 0.25 * random.random()
    return base * jitter


def _call_gemini_with_retry(fn, *, role: str, log_path: Path):
    """Retry ONLY a transport-level failure in `fn` — connection errors,
    timeouts, 429, 5xx. `fn` must be the bare API call and nothing else:
    usage is recorded by the caller, once, only after this returns, so a
    retry here can never double-record it. 2 attempts total; the SDK
    itself does not retry (see module docstring), so this loop IS the
    retry, not a wrapper around one."""
    for attempt_index in range(TOTAL_ATTEMPTS):
        try:
            return fn()
        except Exception as exc:
            is_last_attempt = attempt_index == TOTAL_ATTEMPTS - 1
            if is_last_attempt or not _is_gemini_transport_failure(exc):
                raise
            wait_s = _gemini_retry_after_s(exc)
            if wait_s is None:
                wait_s = _gemini_backoff_s(attempt_index)
            append_run_event(
                log_path,
                event_type="model_call.retried",
                provider="gemini",
                role=role,
                call="models.generate_content",
                retry_number=attempt_index + 1,
            )
            time.sleep(wait_s)
    raise AssertionError("unreachable: the loop above always returns or raises")


def _call_gemini_structured(
    *, role: str, system: str, user: str, tool_name: str, tool_schema: dict, max_tokens: int, log_path: Path
) -> dict:
    """Structured output via response_json_schema (our tool schemas are
    already plain JSON Schema — no translation needed). No prompt-caching
    equivalent is wired here (Gemini's explicit-cache API differs enough
    from Anthropic's ephemeral system-block cache that porting pipeline
    section 6's caching strategy is out of scope for this escape hatch)."""
    from google import genai
    from google.genai import types

    model = resolve_model(role)
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "ORCH_MODEL_PROVIDER=gemini requires GEMINI_API_KEY in orchestrator/.env"
        )
    client = genai.Client(api_key=api_key)
    response = _call_gemini_with_retry(
        lambda: client.models.generate_content(
            model=model,
            contents=user,
            config=types.GenerateContentConfig(
                system_instruction=system,
                max_output_tokens=max_tokens,
                response_mime_type="application/json",
                response_json_schema=tool_schema,
            ),
        ),
        role=role,
        log_path=log_path,
    )
    data = response.parsed if response.parsed is not None else json.loads(response.text)
    usage_metadata = response.usage_metadata
    usage = {
        "input_tokens": usage_metadata.prompt_token_count or 0,
        "output_tokens": usage_metadata.candidates_token_count or 0,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": usage_metadata.cached_content_token_count or 0,
    }
    record_usage(role=role, model=model, usage=usage)
    return {"data": data, "model": model, "usage": usage}


def call_model(
    *, role: str, system: str, user: str, max_tokens: int = 4096, log_path: Path | None = None
) -> dict:
    model = resolve_model(role)
    resolved_log_path = log_path if log_path is not None else default_retry_log_path()
    client = _anthropic_client(role=role, call="messages.create", log_path=resolved_log_path)
    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=build_cached_system(system),
        messages=[{"role": "user", "content": user}],
    )
    text = "".join(block.text for block in response.content if block.type == "text")
    usage = {
        "input_tokens": response.usage.input_tokens,
        "output_tokens": response.usage.output_tokens,
        "cache_creation_input_tokens": getattr(response.usage, "cache_creation_input_tokens", 0) or 0,
        "cache_read_input_tokens": getattr(response.usage, "cache_read_input_tokens", 0) or 0,
    }
    record_usage(role=role, model=model, usage=usage)
    return {"text": text, "model": model, "usage": usage}


model_call = checkpoint(call_model)
