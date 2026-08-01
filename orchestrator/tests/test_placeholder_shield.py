"""Shielding `${...}` from Kitaru's replay-time env-var substitution
(milestone 7.1). The bug this prevents made section regeneration impossible
for 19 of the 20 archetypes; see placeholder_shield's own docstring."""

import re
from pathlib import Path

from orchestrator.placeholder_shield import SENTINEL, shield, shield_value, unshield

# The exact pattern Kitaru (via zenml) substitutes, with raise_when_missing=True.
KITARU_PATTERN = re.compile(r"\$\{([a-zA-Z0-9_]+)\}")

PROMPTS_DIR = Path(__file__).resolve().parents[2] / "prompts" / "archetypes"


def test_shield_round_trips_exactly() -> None:
    source = 'const itemId = `${nodeId}.item-${item.key}`;'
    assert unshield(shield(source)) == source


def test_shielded_text_is_invisible_to_kitaru_substitution() -> None:
    """The whole point: after shielding, the substitution pass finds nothing to
    substitute, so it cannot raise on a missing 'nodeId' env var."""
    source = 'const itemId = `${nodeId}.item-${item.key}`;'
    assert KITARU_PATTERN.search(source) is not None, "precondition: raw text trips the pattern"
    assert KITARU_PATTERN.search(shield(source)) is None


def test_a_dotted_expression_was_never_at_risk() -> None:
    """`${item.key}` contains a dot, which the pattern excludes -- which is why
    shielding the `${` opener alone is sufficient."""
    assert KITARU_PATTERN.search("${item.key}") is None


def test_text_without_placeholders_is_untouched() -> None:
    plain = "A hero section with a headline and two CTAs."
    assert shield(plain) == plain
    assert unshield(plain) == plain


def test_shield_value_walks_containers_and_leaves_non_strings_alone() -> None:
    value = {
        "regen_block": "id = `${nodeId}.x`",
        "ids": ["${nodeId}.a", "plain"],
        "attempt": 3,
        "flag": True,
    }
    shielded = shield_value(value)
    assert SENTINEL in shielded["regen_block"]
    assert shielded["ids"][0].startswith(SENTINEL)
    assert shielded["ids"][1] == "plain"
    assert shielded["attempt"] == 3
    assert shielded["flag"] is True


def test_every_archetype_template_survives_the_substitution_pass_once_shielded() -> None:
    """The regression that matters. 19 of 20 templates embed `${nodeId}` --
    contract 5.2 REQUIRES it for list-item ids -- so before shielding, replaying
    a section generated from any of them raised outright. `hero` is the sole
    template with no occurrences, and it is the only section M4 and 5.5 ever
    regenerated, which is exactly why the breakage went unnoticed."""
    templates = sorted(PROMPTS_DIR.glob("*.md"))
    assert templates, "no archetype templates found"

    tripping = [t.stem for t in templates if KITARU_PATTERN.search(t.read_text(encoding="utf-8"))]
    # documents the scale of the bug, and fails loudly if the catalog changes
    assert len(tripping) >= 18, f"expected almost every template to embed ${{...}}, got {tripping}"
    assert "hero" not in tripping

    for template in templates:
        shielded = shield(template.read_text(encoding="utf-8"))
        assert KITARU_PATTERN.search(shielded) is None, f"{template.stem} still trips substitution"


def test_the_sentinel_does_not_occur_in_any_real_template() -> None:
    """Shielding is only reversible if the sentinel never appears in the text
    it is applied to."""
    for template in sorted(PROMPTS_DIR.glob("*.md")):
        assert SENTINEL not in template.read_text(encoding="utf-8")
