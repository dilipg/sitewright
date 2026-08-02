"""Add-a-section (PRD 4.1, build prompt 7.6). The model call itself is the
section flow, already covered elsewhere; what is specific to adding a section
is the wiring around it — slug allocation that never renumbers an existing id,
appending to index.tsx without destroying the page, and recording the section
in the site plan."""

import json
from pathlib import Path

import pytest

from orchestrator.add_section import (
    append_to_index,
    append_to_siteplan,
    slugify,
    unique_section_slug,
)

ASSEMBLED_INDEX = '''import { heroData } from "./mock/Hero.data";
import Hero from "./sections/Hero";
import { faqData } from "./mock/Faq.data";
import Faq from "./sections/Faq";

/** Page assembly only, no styling decisions (contract section 2). */
export default function HomePage() {
  return (
    <>
      <Hero nodeId="home.hero" {...heroData} />
      <Faq nodeId="home.faq" {...faqData} />
    </>
  );
}
'''


def _manifest(*section_slugs: str) -> dict:
    nodes = {}
    for slug in section_slugs:
        nodes[f"home.{slug}"] = {"component": "X", "route": "/", "status": "active"}
        nodes[f"home.{slug}.heading"] = {"component": "X", "route": "/", "status": "active"}
    return {"version": 1, "nodes": nodes}


def test_slugify_keeps_the_meaning_rather_than_numbering() -> None:
    """Node ids are semantic, never positional (contract 5.2)."""
    assert slugify("Pricing Tiers") == "pricing-tiers"
    assert slugify("  FAQ / accordion!  ") == "faq-accordion"
    assert slugify("!!!") == "section"


def test_a_colliding_slug_suffixes_the_NEW_section_not_the_existing_one() -> None:
    """Ids are immutable once registered, so the new arrival gives way. Renaming
    the existing section would break every override pointing at it."""
    manifest = _manifest("hero", "pricing-tiers")
    assert unique_section_slug(manifest, "home", "faq-accordion") == "faq-accordion"
    assert unique_section_slug(manifest, "home", "pricing-tiers") == "pricing-tiers-2"


def test_collision_suffixes_keep_counting_past_the_first() -> None:
    manifest = _manifest("cta-band", "cta-band-2")
    assert unique_section_slug(manifest, "home", "cta-band") == "cta-band-3"


def test_slug_collisions_are_scoped_to_the_route() -> None:
    """Ids are route-prefixed, so the same section slug on two routes is not a
    collision at all -- suffixing it would invent a difference that isn't one."""
    manifest = _manifest("hero")
    manifest["nodes"]["shop.pricing-tiers"] = {"component": "X", "route": "/shop", "status": "active"}
    assert unique_section_slug(manifest, "home", "pricing-tiers") == "pricing-tiers"


def test_append_to_index_adds_the_section_and_keeps_the_existing_ones() -> None:
    result = append_to_index(
        ASSEMBLED_INDEX, route_slug="home", section_slug="pricing-tiers", component="PricingTiers"
    )
    assert 'import { pricingTiersData } from "./mock/PricingTiers.data";' in result
    assert 'import PricingTiers from "./sections/PricingTiers";' in result
    assert '<PricingTiers nodeId="home.pricing-tiers" {...pricingTiersData} />' in result
    # the sections already on the page are untouched and still in order
    assert result.index('nodeId="home.hero"') < result.index('nodeId="home.faq"')
    assert result.index('nodeId="home.faq"') < result.index('nodeId="home.pricing-tiers"')


def test_append_to_index_appends_LAST_leaving_position_to_the_editor() -> None:
    """A new section lands at the end of the source; the editor places it with a
    sectionOrder override (PRD 3.3). Nothing in the source is renumbered."""
    result = append_to_index(
        ASSEMBLED_INDEX, route_slug="home", section_slug="cta-band", component="CtaBand"
    )
    renders = [line for line in result.split("\n") if "nodeId=" in line]
    assert renders[-1].strip().startswith("<CtaBand")


def test_append_to_index_preserves_a_failed_section_placeholder() -> None:
    """The reason this appends instead of re-assembling: a failed section never
    proposed a manifest entry, so re-assembling from the manifest would drop the
    placeholder entirely and silently shorten the page."""
    with_placeholder = ASSEMBLED_INDEX.replace(
        '      <Faq nodeId="home.faq" {...faqData} />',
        '      <FailedSectionPlaceholder />\n      <Faq nodeId="home.faq" {...faqData} />',
    )
    result = append_to_index(
        with_placeholder, route_slug="home", section_slug="cta-band", component="CtaBand"
    )
    assert "<FailedSectionPlaceholder />" in result
    assert result.index("<FailedSectionPlaceholder />") < result.index("<CtaBand")


def test_adding_a_section_that_is_already_rendered_fails_loudly() -> None:
    with pytest.raises(SystemExit, match="already rendered"):
        append_to_index(ASSEMBLED_INDEX, route_slug="home", section_slug="hero", component="Hero")


def test_a_page_that_is_not_a_section_list_fails_loudly() -> None:
    single = 'import Hero from "./sections/Hero";\n\nexport default function P() {\n  return <Hero />;\n}\n'
    with pytest.raises(SystemExit, match="single element"):
        append_to_index(single, route_slug="home", section_slug="faq", component="Faq")


def test_the_new_section_is_recorded_in_the_site_plan(tmp_path: Path) -> None:
    """The plan is the record of what the site contains; a section living only
    in source would be invisible to anything that reads the plan later."""
    project = tmp_path / "run"
    (project / "plan").mkdir(parents=True)
    (project / "plan" / "siteplan.json").write_text(
        json.dumps(
            {
                "routes": [
                    {"slug": "home", "path": "/", "sections": [{"slug": "hero"}]},
                    {"slug": "shop", "path": "/shop", "sections": []},
                ]
            }
        ),
        encoding="utf-8",
    )
    append_to_siteplan(
        project, "home", {"slug": "cta-band", "archetype": "cta-band", "brief": "closing CTA"}
    )
    plan = json.loads((project / "plan" / "siteplan.json").read_text(encoding="utf-8"))
    home = next(route for route in plan["routes"] if route["slug"] == "home")
    assert [section["slug"] for section in home["sections"]] == ["hero", "cta-band"]
    # the other route is untouched
    assert next(route for route in plan["routes"] if route["slug"] == "shop")["sections"] == []


def test_a_project_with_no_plan_files_is_not_a_failure(tmp_path: Path) -> None:
    """Runs predating plan files (and the fixture) still register the section in
    the manifest and render it -- a missing plan is a missing record, not a
    broken add."""
    project = tmp_path / "run"
    project.mkdir()
    append_to_siteplan(project, "home", {"slug": "cta-band"})  # must not raise


def test_an_unknown_route_in_the_plan_fails_loudly(tmp_path: Path) -> None:
    project = tmp_path / "run"
    (project / "plan").mkdir(parents=True)
    (project / "plan" / "siteplan.json").write_text(
        json.dumps({"routes": [{"slug": "home", "sections": []}]}), encoding="utf-8"
    )
    with pytest.raises(SystemExit, match="not in the site plan"):
        append_to_siteplan(project, "shop", {"slug": "x"})
