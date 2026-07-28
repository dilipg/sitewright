"""The model call as a Kitaru checkpoint — the documented custom-step path
(kitaru.llm() does not yet support the structured output that page agents
need from 3.3). Prompt caching is enabled on Anthropic's system block from
day one (pipeline section 6 assumes it). Every real call records one
token-accounting row; replayed/skipped checkpoints record nothing.

Provider dispatch (ORCH_MODEL_PROVIDER=anthropic|gemini, default anthropic):
an OPT-IN escape hatch, not a target-architecture change — the contract
names the Claude API specifically (pipeline 5.1). Added to keep development
moving during an Anthropic billing-account outage (docs/decisions.md); the
default stays Anthropic and every other doc/prompt assumes it."""

import json
import os

from anthropic import Anthropic
from kitaru import checkpoint

from orchestrator.accounting import record_usage
from orchestrator.config import model_provider, resolve_model


def build_cached_system(text: str) -> list[dict]:
    """System block with a prompt-cache breakpoint: identical across all
    sections of a run, the largest single caching win (pipeline section 6)."""
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]


def call_model_structured_impl(
    *,
    role: str,
    system: str,
    user: str,
    tool_name: str,
    tool_description: str,
    tool_schema: dict,
    max_tokens: int = 8192,
) -> dict:
    """Structured output, dispatched to the configured provider. Plain
    function: callers wrap it in their own checkpointed steps."""
    if model_provider() == "gemini":
        return _call_gemini_structured(
            role=role,
            system=system,
            user=user,
            tool_name=tool_name,
            tool_schema=tool_schema,
            max_tokens=max_tokens,
        )
    return _call_anthropic_structured(
        role=role,
        system=system,
        user=user,
        tool_name=tool_name,
        tool_description=tool_description,
        tool_schema=tool_schema,
        max_tokens=max_tokens,
    )


def _call_anthropic_structured(
    *,
    role: str,
    system: str,
    user: str,
    tool_name: str,
    tool_description: str,
    tool_schema: dict,
    max_tokens: int,
) -> dict:
    """Structured output via a forced tool call: the response IS the tool
    input, schema-validated by the API — no JSON parsing of prose."""
    model = resolve_model(role)
    client = Anthropic()
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


def _call_gemini_structured(
    *, role: str, system: str, user: str, tool_name: str, tool_schema: dict, max_tokens: int
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
    response = client.models.generate_content(
        model=model,
        contents=user,
        config=types.GenerateContentConfig(
            system_instruction=system,
            max_output_tokens=max_tokens,
            response_mime_type="application/json",
            response_json_schema=tool_schema,
        ),
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


def call_model(*, role: str, system: str, user: str, max_tokens: int = 4096) -> dict:
    model = resolve_model(role)
    client = Anthropic()
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
