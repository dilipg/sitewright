"""Pure parts of the single-section pipeline: workspace prep, deterministic
index assembly, failure-report formatting, retry-prompt construction."""

import json
from pathlib import Path

from orchestrator.section_pipeline import (
    assemble_page_index_source,
    build_index_source,
    ensure_route_page_dirs,
    files_of,
    format_gate_failures,
    prepare_workspace_dir,
    proposals_of,
    user_prompt_with_failures,
    validate_root_proposal,
    write_section_files,
)


def test_prepare_workspace_copies_fixture_with_a_blank_page(tmp_path: Path) -> None:
    project = tmp_path / "run-x"
    prepare_workspace_dir(str(project))

    # fixture spine intact (stub table: tokens/primitives/shell stay hand-written)
    assert (project / "src" / "tokens" / "tokens.json").exists()
    assert (project / "src" / "primitives" / "Button.tsx").exists()
    assert (project / "src" / "shell" / "routes.ts").exists()
    assert (project / "package.json").exists()
    assert not (project / "node_modules").exists()

    # the page is blank: no fixture hero, empty manifest, empty overrides
    assert not (project / "src" / "pages" / "home" / "sections").exists()
    manifest = json.loads((project / "manifest.json").read_text())
    assert manifest == {"version": 1, "nodes": {}}
    overrides = json.loads((project / "overrides" / "home.overrides.json").read_text())
    assert overrides["overrides"] == []


def test_prepare_workspace_fully_replaces_a_stale_dir(tmp_path: Path) -> None:
    project = tmp_path / "run-x"
    project.mkdir(parents=True)
    (project / "stale.txt").write_text("old")
    prepare_workspace_dir(str(project))
    assert not (project / "stale.txt").exists()


def test_prepare_workspace_preserves_the_plan_directory(tmp_path: Path) -> None:
    """The approved plan is part of the project's atomic state (PRD 6) and
    must survive workspace resets."""
    project = tmp_path / "run-x"
    plan_dir = project / "plan"
    plan_dir.mkdir(parents=True)
    (plan_dir / "siteplan.json").write_text('{"routes": []}')
    (plan_dir / "plan-status.json").write_text('{"approved": true}')

    prepare_workspace_dir(str(project))

    assert (project / "plan" / "siteplan.json").read_text() == '{"routes": []}'
    assert (project / "plan" / "plan-status.json").exists()
    assert (project / "src" / "tokens" / "tokens.json").exists()


def test_prepare_workspace_scaffolds_extra_route_page_dirs(tmp_path: Path) -> None:
    """Fan-out (5.3) needs an empty pages/<slug>/ + overrides file for every
    planned route, not just 'home' — the fixture only ships 'home'."""
    project = tmp_path / "run-x"
    routes = [
        {"slug": "home", "path": "/"},
        {"slug": "pricing", "path": "/pricing"},
        {"slug": "about", "path": "/about"},
    ]
    prepare_workspace_dir(str(project), routes=routes)

    for route in routes:
        slug = route["slug"]
        assert not (project / "src" / "pages" / slug / "sections").exists()
        assert not (project / "src" / "pages" / slug / "index.tsx").exists()
        overrides = json.loads((project / "overrides" / f"{slug}.overrides.json").read_text())
        assert overrides == {"version": 1, "route": route["path"], "overrides": []}


def test_prepare_workspace_default_route_slugs_is_home_only(tmp_path: Path) -> None:
    """Back-compat: every M3/M4/soak/stress call site omits routes= and
    must keep behaving exactly as before (single 'home' route)."""
    project = tmp_path / "run-x"
    prepare_workspace_dir(str(project))
    assert (project / "overrides" / "home.overrides.json").exists()
    assert not (project / "src" / "pages" / "pricing").exists()


def test_ensure_route_page_dirs_is_additive_and_non_destructive(tmp_path: Path) -> None:
    """Fan-out (5.3) scaffolds routes BEYOND what the DS agent's initial
    prepare_workspace created, without resetting tokens/primitives/shell
    the DS/Shell agents already wrote into this same workspace."""
    project = tmp_path / "run-x"
    prepare_workspace_dir(str(project))  # DS agent's initial prep: home only
    (project / "src" / "tokens" / "tokens.json").write_text('{"generated": true}')

    ensure_route_page_dirs(
        str(project), routes=[{"slug": "home", "path": "/"}, {"slug": "pricing", "path": "/pricing"}]
    )

    assert (project / "src" / "pages" / "pricing").exists()
    overrides = json.loads((project / "overrides" / "pricing.overrides.json").read_text())
    assert overrides == {"version": 1, "route": "/pricing", "overrides": []}
    # the DS agent's already-written tokens survived — not reset
    assert json.loads((project / "src" / "tokens" / "tokens.json").read_text()) == {"generated": True}


def test_ensure_route_page_dirs_does_not_clobber_existing_overrides(tmp_path: Path) -> None:
    project = tmp_path / "run-x"
    prepare_workspace_dir(str(project))
    overrides_path = project / "overrides" / "home.overrides.json"
    overrides_path.write_text(json.dumps({"version": 1, "route": "/", "overrides": [{"nodeId": "x"}]}))

    ensure_route_page_dirs(str(project), routes=[{"slug": "home", "path": "/"}])

    assert json.loads(overrides_path.read_text())["overrides"] == [{"nodeId": "x"}]


def test_write_section_files_does_not_touch_sibling_sections(tmp_path: Path) -> None:
    """Multiple sections coexist per page; writing/retrying one section must
    fully replace ONLY its own files (contract 5.3), never a sibling's."""
    project = tmp_path / "run-x"
    page = project / "src" / "pages" / "home"
    (page / "sections").mkdir(parents=True)
    (page / "mock").mkdir(parents=True)
    (page / "sections" / "Hero.tsx").write_text("old hero")
    (page / "mock" / "Hero.data.ts").write_text("old hero data")
    (page / "sections" / "Features.tsx").write_text("existing sibling")
    (page / "mock" / "Features.data.ts").write_text("existing sibling data")

    write_section_files(
        str(project),
        route_slug="home",
        component="Hero",
        files={
            "src/pages/home/sections/Hero.tsx": "new hero",
            "src/pages/home/mock/Hero.data.ts": "new hero data",
        },
    )

    assert (page / "sections" / "Hero.tsx").read_text() == "new hero"
    assert (page / "mock" / "Hero.data.ts").read_text() == "new hero data"
    # sibling section untouched
    assert (page / "sections" / "Features.tsx").read_text() == "existing sibling"
    assert (page / "mock" / "Features.data.ts").read_text() == "existing sibling data"


def test_write_section_files_replaces_its_own_prior_attempt(tmp_path: Path) -> None:
    project = tmp_path / "run-x"
    write_section_files(
        str(project),
        route_slug="home",
        component="Hero",
        files={
            "src/pages/home/sections/Hero.tsx": "attempt 1, extra stray content",
            "src/pages/home/mock/Hero.data.ts": "attempt 1 data",
        },
    )
    write_section_files(
        str(project),
        route_slug="home",
        component="Hero",
        files={
            "src/pages/home/sections/Hero.tsx": "attempt 2",
            "src/pages/home/mock/Hero.data.ts": "attempt 2 data",
        },
    )
    section_file = project / "src" / "pages" / "home" / "sections" / "Hero.tsx"
    assert section_file.read_text() == "attempt 2"


def test_assemble_page_index_source_renders_sections_in_order() -> None:
    source = assemble_page_index_source(
        route_slug="pricing",
        sections=[
            {"slug": "tiers", "component": "PricingTiers"},
            {"slug": "faq", "component": "FaqAccordion"},
        ],
    )
    assert 'import PricingTiers from "./sections/PricingTiers";' in source
    assert 'import FaqAccordion from "./sections/FaqAccordion";' in source
    assert 'import { pricingTiersData } from "./mock/PricingTiers.data";' in source
    assert '<PricingTiers nodeId="pricing.tiers" {...pricingTiersData} />' in source
    assert '<FaqAccordion nodeId="pricing.faq" {...faqAccordionData} />' in source
    # order preserved: tiers appears before faq in the render body
    render_start = source.index("return")
    assert source.index("PricingTiers nodeId", render_start) < source.index("FaqAccordion nodeId", render_start)


def test_assemble_page_index_source_handles_a_failed_section_placeholder() -> None:
    """Pipeline 5.4: a failed section renders as a labeled placeholder rather
    than blocking the rest of the page."""
    source = assemble_page_index_source(
        route_slug="home",
        sections=[
            {"slug": "hero", "component": "Hero"},
            {"slug": "broken", "failed": True},
        ],
    )
    assert 'import Hero from "./sections/Hero";' in source
    assert "FailedSectionPlaceholder" in source
    assert '"home.broken"' in source


def test_build_index_source_assembles_the_section() -> None:
    source = build_index_source(
        route_slug="home",
        section_slug="hero",
        component="Hero",
    )
    assert 'import Hero from "./sections/Hero";' in source
    assert 'import { heroData } from "./mock/Hero.data";' in source
    assert '<Hero nodeId="home.hero" {...heroData} />' in source


def test_format_gate_failures_is_actionable_and_names_the_attempt() -> None:
    report = {
        "passed": False,
        "gates": [
            {"gate": 3, "name": "tokens-only", "passed": False, "failures": [
                {"gate": 3, "reason": "raw-hex", "message": 'Raw hex color "#ff0000" at src/pages/home/sections/Hero.tsx:12.'}
            ]},
            {"gate": 5, "name": "content-via-props", "passed": True, "failures": []},
        ],
    }
    text = format_gate_failures(report)
    assert 'Raw hex color "#ff0000"' in text
    assert "gate 3" in text


def test_user_prompt_with_failures_appends_the_report_block() -> None:
    base = "[PAGE CONTEXT]\n..."
    with_failures = user_prompt_with_failures(base, "gate 3: Raw hex color ...")
    assert with_failures.startswith(base)
    assert "PREVIOUS ATTEMPT FAILED VALIDATION" in with_failures
    assert "gate 3: Raw hex color" in with_failures
    # first attempt: unchanged
    assert user_prompt_with_failures(base, "") == base


def test_files_of_returns_the_declared_files() -> None:
    model_result = {"data": {"files": {"a.tsx": "content"}}}
    assert files_of(model_result) == {"a.tsx": "content"}


def test_files_of_parses_a_double_encoded_json_string() -> None:
    # Live-observed: under retry pressure, the model returned "files" as a
    # JSON-encoded STRING (double-encoding) instead of a native object,
    # despite the tool schema declaring it type "object" — Claude's tool-use
    # does not hard-enforce declared types any more than required fields.
    # `.items()` on that string crashed the whole page worker.
    model_result = {"data": {"files": '{"a.tsx": "content"}'}}
    assert files_of(model_result) == {"a.tsx": "content"}


def test_files_of_defaults_to_empty_dict_when_unparseable() -> None:
    model_result = {"data": {"files": "not json at all"}}
    assert files_of(model_result) == {}


def test_proposals_of_returns_the_declared_proposals() -> None:
    model_result = {"data": {"manifestProposals": [{"nodeId": "shop.hero"}]}}
    assert proposals_of(model_result) == [{"nodeId": "shop.hero"}]


def test_proposals_of_defaults_to_empty_list_when_the_model_omits_the_field() -> None:
    # Live-observed: the tool schema declares manifestProposals required, but
    # Claude's tool-use does not hard-enforce required fields — the model can
    # still omit it under retry pressure. Must degrade to a clean validation
    # failure downstream, never an unhandled KeyError that crashes the whole
    # page worker mid-fan-out.
    model_result = {"data": {"files": {}, "sectionMeta": {"slug": "hero", "component": "Hero", "summary": ""}}}
    assert proposals_of(model_result) == []


def test_validate_root_proposal_passes_when_the_root_id_is_proposed() -> None:
    proposals = [
        {"nodeId": "shop.collection-header", "route": "/shop", "file": "x", "component": "CollectionHeader", "element": "section", "editable": ["style"]},
        {"nodeId": "shop.collection-header.title", "route": "/shop", "file": "x", "component": "CollectionHeader", "element": "Heading", "editable": ["text"]},
    ]
    assert validate_root_proposal("shop.collection-header", proposals) == ""


def test_validate_root_proposal_fails_when_the_model_only_proposes_children() -> None:
    # Reproduces a real live-run defect: the model registered every child of
    # CollectionHeader but never proposed an entry for the section's own
    # root, so the root could never become an active manifest node — its
    # later literal attachment in the assembled page's index.tsx then shows
    # up as "unregistered-node-id" with no retry budget left to fix it.
    proposals = [
        {"nodeId": "shop.collection-header.title", "route": "/shop", "file": "x", "component": "CollectionHeader", "element": "Heading", "editable": ["text"]},
    ]
    failure = validate_root_proposal("shop.collection-header", proposals)
    assert "shop.collection-header" in failure
    assert failure != ""
