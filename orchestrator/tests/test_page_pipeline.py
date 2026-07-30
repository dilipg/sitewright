"""Per-archetype template selection (build prompt 5.4: six dedicated
archetypes; everything else still falls back to the generic scaffold)."""

from orchestrator.page_pipeline import select_template

DEDICATED_ARCHETYPES = [
    "hero",
    "feature-grid",
    "cta-band",
    "pricing-tiers",
    "faq-accordion",
    "social-proof",
]


def test_each_dedicated_archetype_selects_its_own_template() -> None:
    for archetype in DEDICATED_ARCHETYPES:
        template = select_template(archetype)
        assert template.archetype == archetype


def test_an_uncataloged_archetype_falls_back_to_generic_section() -> None:
    # "custom" is the permanent fallback archetype (contract 4.4) — it never
    # gets a dedicated template by design, unlike the 19 named archetypes,
    # all of which have one as of build prompt 6.1.
    template = select_template("custom")
    assert template.archetype == "generic-section"


def test_selection_is_cached_across_calls() -> None:
    first = select_template("feature-grid")
    second = select_template("feature-grid")
    assert first is second
