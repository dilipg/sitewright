"""Pure parts of the model-call step: prompt-cache block construction."""

from orchestrator.model_call import build_cached_system


def test_system_block_carries_cache_control() -> None:
    blocks = build_cached_system("You are a page agent.")
    assert blocks == [
        {
            "type": "text",
            "text": "You are a page agent.",
            "cache_control": {"type": "ephemeral"},
        }
    ]
