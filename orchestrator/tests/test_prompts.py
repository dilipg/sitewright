"""Template engine: block assembly per pipeline 4.1, versioning, hashing."""

import pytest

from orchestrator.design_context import build_design_context
from orchestrator.fixture_context import fixture_primitive_signatures, fixture_tokens
from orchestrator.prompts import load_template, render_template


def fixture_render_context() -> dict[str, str]:
    return {
        "design_context": build_design_context(
            fixture_tokens(), fixture_primitive_signatures()
        ),
        "route_slug": "home",
        "route_path": "/",
        "page_brief": "Landing page for Acme Analytics, a product analytics tool.",
        "prior_sections": "(none — this is the first section on the page)",
        "route_table": '[{"slug": "home", "path": "/", "title": "Home"}]',
        "section_slug": "hero",
        "section_brief": "Bold hero introducing Acme Analytics with a trial CTA.",
        "regen_block": "(first generation — no regeneration context)",
    }


def test_hero_template_has_version_and_stable_hash() -> None:
    first = load_template("hero")
    second = load_template("hero")
    assert first.version.count(".") == 2  # semver from frontmatter
    assert first.archetype == "hero"
    assert first.content_hash == second.content_hash
    assert len(first.content_hash) == 12


def test_rendering_fills_every_block(  # the 3.2 VERIFY criterion
) -> None:
    template = load_template("hero")
    rendered = render_template(template, fixture_render_context())

    # cacheable prefix: SYSTEM + DESIGN CONTEXT
    assert "[SYSTEM]" in rendered.system
    assert "[DESIGN CONTEXT]" in rendered.system
    assert "color.semantic" in rendered.system

    # per-section remainder
    assert "[PAGE CONTEXT]" in rendered.user
    assert "[ARCHETYPE]" in rendered.user
    assert "[SECTION BRIEF]" in rendered.user
    assert "[REGEN]" in rendered.user
    assert "Bold hero introducing Acme Analytics" in rendered.user

    assert rendered.template_version == template.version
    assert rendered.template_hash == template.content_hash
    assert len(rendered.prompt_hash) == 12


def test_rendering_is_deterministic() -> None:
    template = load_template("hero")
    first = render_template(template, fixture_render_context())
    second = render_template(template, fixture_render_context())
    assert first.prompt_hash == second.prompt_hash
    assert first.system == second.system
    assert first.user == second.user


def test_missing_placeholder_value_fails_loudly() -> None:
    template = load_template("hero")
    context = fixture_render_context()
    del context["section_brief"]
    with pytest.raises(KeyError, match="section_brief"):
        render_template(template, context)


def test_unknown_context_key_fails_loudly() -> None:
    template = load_template("hero")
    context = fixture_render_context() | {"typo_key": "x"}
    with pytest.raises(KeyError, match="typo_key"):
        render_template(template, context)


def test_no_unresolved_placeholders_survive_rendering() -> None:
    template = load_template("hero")
    rendered = render_template(template, fixture_render_context())
    assert "{{" not in rendered.system
    assert "{{" not in rendered.user


NEW_5_4_ARCHETYPES = ["feature-grid", "cta-band", "pricing-tiers", "faq-accordion", "social-proof"]


@pytest.mark.parametrize("archetype", NEW_5_4_ARCHETYPES)
def test_new_archetype_templates_load_and_render_cleanly(archetype: str) -> None:
    template = load_template(archetype)
    assert template.archetype == archetype
    assert template.version.count(".") == 2

    context = fixture_render_context() | {"section_slug": archetype, "section_brief": f"Test brief for {archetype}."}
    rendered = render_template(template, context)
    assert "{{" not in rendered.system
    assert "{{" not in rendered.user
    # canonical example must be present (few-shot quality bar, pipeline 4.1)
    assert "Canonical example" in rendered.user
    assert "manifestProposals for that example" in rendered.user
