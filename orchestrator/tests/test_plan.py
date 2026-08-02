"""Site-plan validation (pipeline 2.2/4.3): catalog-only archetypes, the
custom budget rule, landing priors as hard checks, and the approval gate."""

import json
from pathlib import Path

import pytest

from orchestrator.catalog import ARCHETYPE_CATALOG, PAGE_ARCHETYPES
from orchestrator.plan_pipeline import require_plan_approval, validate_siteplan


def landing_plan() -> dict:
    return {
        "routes": [
            {
                "slug": "home",
                "path": "/",
                "pageArchetype": "landing",
                "title": "Home",
                "sections": [
                    {"slug": "hero", "archetype": "hero", "brief": "Bold intro."},
                    {"slug": "features", "archetype": "feature-grid", "brief": "Key features."},
                    {"slug": "proof", "archetype": "social-proof", "brief": "Testimonials."},
                    {"slug": "faq", "archetype": "faq-accordion", "brief": "Common questions."},
                    {"slug": "cta", "archetype": "cta-band", "brief": "Final push."},
                ],
            },
            {
                "slug": "pricing",
                "path": "/pricing",
                "pageArchetype": "marketing-page",
                "title": "Pricing",
                "sections": [
                    {"slug": "tiers", "archetype": "pricing-tiers", "brief": "Three tiers."},
                    {"slug": "faq", "archetype": "faq-accordion", "brief": "Billing questions."},
                ],
            },
        ]
    }


def test_catalog_shape() -> None:
    # 19 at v1 (pipeline 4.2's twenty, counting "custom"), plus the 8-archetype
    # app set; 4.2 states that growing this catalog is ongoing product work.
    assert len(ARCHETYPE_CATALOG) == 27
    assert "hero" in ARCHETYPE_CATALOG
    assert "product-detail" in ARCHETYPE_CATALOG
    assert set(PAGE_ARCHETYPES) == {
        "landing",
        "marketing-page",
        "storefront",
        "saas-product",
        "app-screen",
    }


def test_valid_plan_passes() -> None:
    assert validate_siteplan(landing_plan()) == []


def test_non_catalog_archetype_fails() -> None:
    plan = landing_plan()
    plan["routes"][0]["sections"][1]["archetype"] = "mega-carousel"
    issues = validate_siteplan(plan)
    assert any("mega-carousel" in issue for issue in issues)


def test_custom_is_allowed_but_budgeted_to_one_per_page() -> None:
    plan = landing_plan()
    plan["routes"][0]["sections"][1]["archetype"] = "custom"
    assert validate_siteplan(plan) == []
    plan["routes"][0]["sections"][2]["archetype"] = "custom"
    issues = validate_siteplan(plan)
    assert any("custom" in issue for issue in issues)


def test_landing_priors_are_hard_rules() -> None:
    plan = landing_plan()
    plan["routes"][0]["sections"][0]["archetype"] = "stats-band"  # hero not first
    assert any("hero" in issue for issue in validate_siteplan(plan))

    plan = landing_plan()
    plan["routes"][0]["sections"][-1]["archetype"] = "faq-accordion"  # cta-band not last
    assert any("cta-band" in issue for issue in validate_siteplan(plan))

    plan = landing_plan()
    plan["routes"][0]["sections"] = plan["routes"][0]["sections"][:3]  # < 4 sections
    assert any("4" in issue for issue in validate_siteplan(plan))


def test_duplicate_slugs_and_paths_fail() -> None:
    plan = landing_plan()
    plan["routes"][1]["slug"] = "home"
    assert any("home" in issue for issue in validate_siteplan(plan))

    plan = landing_plan()
    plan["routes"][1]["path"] = "/"
    assert any("/" in issue for issue in validate_siteplan(plan))


def test_missing_home_route_fails() -> None:
    plan = landing_plan()
    plan["routes"][0]["path"] = "/start"
    assert any('"/"' in issue for issue in validate_siteplan(plan))


def test_approval_gate(tmp_path: Path) -> None:
    # no plan directory: legacy canned-brief runs are allowed
    require_plan_approval(tmp_path)

    plan_dir = tmp_path / "plan"
    plan_dir.mkdir()
    (plan_dir / "plan-status.json").write_text(json.dumps({"approved": False}))
    with pytest.raises(SystemExit, match="not been approved"):
        require_plan_approval(tmp_path)

    (plan_dir / "plan-status.json").write_text(json.dumps({"approved": True}))
    require_plan_approval(tmp_path)
