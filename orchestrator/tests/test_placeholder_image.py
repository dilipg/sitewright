"""G5: a generated site must never reference an image that cannot load.

The dogfood run pointed every image at `images.yourbrand.example`, so a tester's
first view of their own site was broken images throughout; round 1 had already
reported "ten broken `.example` images from two different invented hostnames" and
nothing was done. `.example` is reserved by IANA (RFC 2606) so that it can never
resolve — permanently, on every network — which is what makes this a defect of
the SPEC rather than of any one generated file.

Two things are pinned here, in the shape `test_primitive_spec_satisfiable.py`
established for the `<UNKNOWN>` fix: a prompt change cannot be tested by running
it, so the tests pin the instruction's PRESENCE (in the rendered prompt, not just
in a file on disk) and its PREMISE (so the assertions cannot pass vacuously once
the thing they describe is gone). The deterministic repair underneath is testable
directly, and is what makes shipping the defect impossible when a model ignores
the prompt — the same division of labour as the brand-name backstop.

NOT COVERED HERE, and stated rather than implied: no live model has generated a
section under the new instruction. These tests prove the instruction reaches
every archetype's prompt and that the repair catches the value the live run
actually produced; they cannot prove a model obeys prose.
"""

from __future__ import annotations

import json
import re
import xml.etree.ElementTree as ElementTree
from pathlib import Path
from urllib.parse import unquote

import pytest

from orchestrator.design_pipeline import PRIMITIVE_SPECS
from orchestrator.page_pipeline import DEDICATED_TEMPLATES
from orchestrator.placeholder_image import (
    HOISTED_CONST_NAME,
    PLACEHOLDER_COMMENT,
    PLACEHOLDER_IMAGE_DATA_URI,
    find_unloadable_image_urls,
    inline_hoisted_string_consts,
    is_unloadable_image_url,
    is_unresolvable_host,
    repair_image_sources,
)
from orchestrator.placeholder_shield import shield, unshield
from orchestrator.prompts import PROMPTS_DIR, load_template, render_template
from orchestrator.section_pipeline import (
    is_mock_data_file,
    write_files_repairing_images,
    write_section_files,
    write_section_output,
)

from test_prompts import fixture_render_context

#: Verbatim from the dogfood run's generated site. The whole finding in one
#: string; if the repair stops catching this exact value, the defect is back.
DOGFOOD_URL = "https://images.yourbrand.example/products/amber-dusk.jpg"

#: Every template, not a hand-kept subset — the same reasoning as
#: test_prompts.py's parametrization: the 6.1 additions went uncovered when a
#: test enumerated only the archetypes that existed when it was written.
ALL_ARCHETYPES = sorted(DEDICATED_TEMPLATES)


# --------------------------------------------------------------------------
# premise guards: without these, everything below could pass vacuously
# --------------------------------------------------------------------------


def test_sections_still_reference_images_by_url_string() -> None:
    """The premise of the whole fix.

    If `Image` ever stopped taking a `src` string — if images arrived as
    imported modules, say — the instruction below would be guidance for a
    requirement that no longer exists, and every assertion in this file would be
    green and meaningless.
    """
    assert "src" in PRIMITIVE_SPECS["Image"]


def test_every_archetype_still_has_the_digest_the_rule_was_added_to() -> None:
    """The rule was appended to the CONTRACT DIGEST of each template. If a
    template is ever restructured away from that digest, the rule silently stops
    being where this file claims it is."""
    for archetype in ALL_ARCHETYPES:
        source = (PROMPTS_DIR / f"{archetype}.md").read_text(encoding="utf-8")
        assert "CONTRACT DIGEST" in source, archetype


# --------------------------------------------------------------------------
# the instruction reaches every archetype's RENDERED prompt
# --------------------------------------------------------------------------


@pytest.mark.parametrize("archetype", ALL_ARCHETYPES)
def test_the_image_rule_reaches_the_rendered_system_prompt(archetype: str) -> None:
    """Rendered, not read off disk — the 6.1 bug that cost the most time was
    invisible in the template and only showed up in the rendered prompt."""
    context = fixture_render_context() | {
        "section_slug": archetype,
        "section_brief": f"Test brief for {archetype}.",
    }
    rendered = render_template(load_template(archetype), context)

    # the literal the model is to copy, shown AS a field's quoted value
    assert PLACEHOLDER_IMAGE_DATA_URI in rendered.system, archetype
    assert f'imageSrc: "{PLACEHOLDER_IMAGE_DATA_URI}"' in rendered.system, archetype
    # and WHY, naming the failure. An unexplained "use this literal" reads as
    # style advice and gets ignored; the `<UNKNOWN>` fix needed the same.
    assert "never resolve" in rendered.system.lower(), archetype
    assert "*.example" in rendered.system, archetype


@pytest.mark.parametrize("archetype", ALL_ARCHETYPES)
def test_every_archetype_forbids_hoisting_the_uri_into_a_shared_const(archetype: str) -> None:
    """C1, the whole-branch review's Critical, pinned at the prompt.

    The first version of this rule told every page agent to declare one
    `const PLACEHOLDER_IMAGE = "..."` per mock data file and reference it. That
    makes the image field an `Identifier`, and contract 7.1's text channel — which
    image replace (PRD 3.5 / feature 7.7) IS, with key `src` — rewrites a
    `StringLiteral` or refuses. So one shared const turned a single image edit
    into a permanent whole-export failure.

    The const name must still APPEAR (naming the anti-pattern is what makes the
    prohibition legible), but only inside a prohibition — so this asserts both:
    the name is present, and it is never presented as a declaration to copy.
    """
    context = fixture_render_context() | {
        "section_slug": archetype,
        "section_brief": f"Test brief for {archetype}.",
    }
    system = render_template(load_template(archetype), context).system

    assert HOISTED_CONST_NAME in system, archetype
    assert f"NEVER hoist it into a shared const" in system, archetype
    # the exact declaration the old rule taught must not be teachable any more
    assert f'const {HOISTED_CONST_NAME} = "{PLACEHOLDER_IMAGE_DATA_URI}"' not in system, archetype
    # and the reason is stated, not just the ban
    assert "STRING LITERAL" in system, archetype
    assert "7.1" in system, archetype


@pytest.mark.parametrize("archetype", ALL_ARCHETYPES)
def test_no_archetype_teaches_an_image_url_that_cannot_load(archetype: str) -> None:
    """A worked example outweighs a prose rule: six templates showed
    `images.yourbrand.example/...jpg` in their mock data, which is exactly what
    the live runs emitted. The rule and the example must agree."""
    source = (PROMPTS_DIR / f"{archetype}.md").read_text(encoding="utf-8")
    found = find_unloadable_image_urls(source)
    assert found == [], (
        f"{archetype}.md teaches image URLs that can never resolve: {sorted(set(found))}. "
        "Inline the placeholder data URI at each image field instead."
    )


IMAGE_ARCHETYPES = ["cart-drawer", "category-nav", "feature-spotlight",
                    "product-card-grid", "product-detail", "team-grid"]


@pytest.mark.parametrize("archetype", IMAGE_ARCHETYPES)
def test_the_image_archetypes_inline_the_uri_at_every_image_field(archetype: str) -> None:
    """C1 again, this time at the worked example — which outweighs a prose rule.

    Every image field in the canonical mock data must carry the URI as its own
    quoted string, and the example must contain no hoisted declaration at all.
    Before the fix this file asserted the OPPOSITE ("used unquoted as an
    identifier, not re-inlined as a string per item"), which is how a
    contract-violating shape got pinned as intended.
    """
    source = (PROMPTS_DIR / f"{archetype}.md").read_text(encoding="utf-8")
    example = source[source.index("[ARCHETYPE]") :]

    assert f'const {HOISTED_CONST_NAME} =' not in example
    assert f": {HOISTED_CONST_NAME}," not in example
    # every image field is its own literal, and there is more than one of them
    # (each of these six archetypes maps over a list) — so the duplication the
    # contract requires is actually demonstrated, not merely described
    assert example.count(f'"{PLACEHOLDER_IMAGE_DATA_URI}"') >= 2
    # the one-line handover story survives the change
    assert PLACEHOLDER_COMMENT in example


@pytest.mark.parametrize("archetype", IMAGE_ARCHETYPES)
def test_the_worked_examples_bind_the_uri_to_an_image_key(archetype: str) -> None:
    """Not just "the URI is in the file" — it has to be the VALUE of a field
    whose name is an image field, which is what the exporter walks to."""
    source = (PROMPTS_DIR / f"{archetype}.md").read_text(encoding="utf-8")
    example = source[source.index("[ARCHETYPE]") :]
    bound_keys = re.findall(rf'(\w+): "{re.escape(PLACEHOLDER_IMAGE_DATA_URI)}"', example)
    assert bound_keys, archetype
    assert all(re.search(r"src|image|photo|logo|avatar", key, re.IGNORECASE) for key in bound_keys), (
        archetype,
        bound_keys,
    )


def test_the_docs_toc_placeholder_links_are_deliberately_left_alone() -> None:
    """Scope, pinned. `docs-toc-page`'s own rule 6 tells the agent to point doc
    entries at `docs.yourbrand.example` because no per-article route exists. A
    dead LINK is a different finding; rewriting an href into an image data URI
    would be nonsense. If this ever becomes desirable it needs its own fix, not
    a widened image repair."""
    source = (PROMPTS_DIR / "docs-toc-page.md").read_text(encoding="utf-8")
    assert "https://docs.yourbrand.example/quickstart" in source
    assert find_unloadable_image_urls(source) == []


# --------------------------------------------------------------------------
# the placeholder value itself
# --------------------------------------------------------------------------


def test_the_placeholder_needs_no_network() -> None:
    assert PLACEHOLDER_IMAGE_DATA_URI.startswith("data:image/svg+xml,")
    assert "http://www.w3.org/2000/svg" in PLACEHOLDER_IMAGE_DATA_URI  # the XML namespace, not a fetch
    body = PLACEHOLDER_IMAGE_DATA_URI.split(",", 1)[1]
    assert "https://" not in body


def test_the_placeholder_decodes_to_well_formed_scaling_svg() -> None:
    svg = unquote(PLACEHOLDER_IMAGE_DATA_URI.split(",", 1)[1])
    root = ElementTree.fromstring(svg)  # raises on malformed XML
    assert root.tag.endswith("svg")
    # viewBox with no width/height is what makes it stretch to the box the
    # Image primitive gives it; with intrinsic pixel dimensions instead, the
    # rect would not scale and the image would render as a sliver.
    assert "viewBox" in root.attrib
    assert "width" not in root.attrib and "height" not in root.attrib


def test_the_placeholder_survives_gate_3() -> None:
    """The load-bearing encoding detail.

    Gate 3 scans every in-scope file, mock data included, and fails a raw hex
    colour or a raw px value. Both regexes are transcribed from
    compiler/src/gates.ts (RAW_HEX, RAW_PX) — `compiler/` cannot be imported
    from Python, so a copy plus this comment is the honest option. A literal
    `#e4e7ec` in the URI would fail gate 3 on EVERY section that has an image,
    on every retry, forever.
    """
    raw_hex = re.compile(r"#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b")
    raw_px = re.compile(r"\b\d+(?:\.\d+)?px\b")
    assert raw_hex.search(PLACEHOLDER_IMAGE_DATA_URI) is None
    assert raw_px.search(PLACEHOLDER_IMAGE_DATA_URI) is None


def test_the_placeholder_drops_into_a_double_quoted_typescript_string() -> None:
    # The SVG uses single quotes throughout precisely so this holds; a double
    # quote would need escaping in every generated mock data file.
    assert '"' not in PLACEHOLDER_IMAGE_DATA_URI
    assert "\\" not in PLACEHOLDER_IMAGE_DATA_URI


def test_the_placeholder_round_trips_through_the_kitaru_shield() -> None:
    """It travels inside stored prompts, which Kitaru substitutes env vars into
    on replay. `${` is the pattern that broke section regeneration for 19 of 20
    archetypes; the URI must not reintroduce it."""
    assert "${" not in PLACEHOLDER_IMAGE_DATA_URI
    assert unshield(shield(PLACEHOLDER_IMAGE_DATA_URI)) == PLACEHOLDER_IMAGE_DATA_URI


# --------------------------------------------------------------------------
# the deterministic backstop
# --------------------------------------------------------------------------


class TestDetection:
    def test_the_exact_value_the_dogfood_run_shipped(self) -> None:
        assert is_unloadable_image_url(DOGFOOD_URL, "imageSrc")

    @pytest.mark.parametrize(
        "host",
        ["images.yourbrand.example", "cdn.acme.invalid", "assets.brand.test",
         "localhost", "example.com", "cdn.example.org", "IMAGES.YOURBRAND.EXAMPLE"],
    )
    def test_reserved_hosts_are_unresolvable(self, host: str) -> None:
        assert is_unresolvable_host(host)

    @pytest.mark.parametrize(
        "host",
        ["images.unsplash.com", "cdn.shopify.com", "res.cloudinary.com",
         "examples.acme.com", "my-example.com", "images.testbrand.com"],
    )
    def test_real_hosts_are_left_alone(self, host: str) -> None:
        # A brief may legitimately supply a real image URL, and a host that
        # merely CONTAINS "example" or "test" is not reserved — the same
        # whole-label discipline the brand-name guard needed for "Brandywine".
        assert not is_unresolvable_host(host)

    def test_a_real_host_image_is_not_rewritten(self) -> None:
        assert not is_unloadable_image_url(
            "https://images.unsplash.com/photo-1234.jpg", "imageSrc"
        )

    def test_an_extensionless_image_endpoint_is_caught_by_its_key(self) -> None:
        assert is_unloadable_image_url("https://images.yourbrand.example/hero", "photoSrc")

    def test_a_link_key_is_never_an_image(self) -> None:
        assert not is_unloadable_image_url("https://docs.yourbrand.example/quickstart", "href")
        # even when it points at an image file
        assert not is_unloadable_image_url("https://x.example/logo.png", "href")

    def test_image_url_is_still_an_image_despite_ending_in_url(self) -> None:
        # The link-key regex is anchored so `imageUrl` does not match `url`.
        assert is_unloadable_image_url("https://x.example/hero", "imageUrl")

    def test_a_non_image_file_is_left_alone(self) -> None:
        """detail-drawer's own canonical example, verbatim: an uploaded PDF on a
        reserved host. Its key contains "src", so a key-only rule would swap a
        document attachment for a grey swatch."""
        assert not is_unloadable_image_url(
            "https://files.yourbrand.example/northwind-team-structure.pdf", "mediaSrc"
        )


class TestRepair:
    def test_it_replaces_the_url_with_the_placeholder(self) -> None:
        source = f'  imageSrc: "{DOGFOOD_URL}",\n'
        repaired, replaced = repair_image_sources(source)
        assert replaced == [DOGFOOD_URL]
        assert DOGFOOD_URL not in repaired
        assert PLACEHOLDER_IMAGE_DATA_URI in repaired
        # the surrounding syntax survives: still a quoted string on that key
        assert repaired == f'  imageSrc: "{PLACEHOLDER_IMAGE_DATA_URI}",\n'

    def test_it_repairs_a_tsx_attribute_too(self) -> None:
        repaired, replaced = repair_image_sources(f'<img src="{DOGFOOD_URL}" />')
        assert replaced == [DOGFOOD_URL]
        assert PLACEHOLDER_IMAGE_DATA_URI in repaired

    def test_it_is_idempotent(self) -> None:
        once, _ = repair_image_sources(f'src: "{DOGFOOD_URL}"')
        twice, replaced = repair_image_sources(once)
        assert twice == once
        assert replaced == []

    def test_it_leaves_a_deliberate_placeholder_link_alone(self) -> None:
        source = '{ title: "Quickstart", href: "https://docs.yourbrand.example/quickstart" }'
        repaired, replaced = repair_image_sources(source)
        assert repaired == source
        assert replaced == []

    def test_it_leaves_a_real_supplied_url_alone(self) -> None:
        source = 'imageSrc: "https://cdn.acmeroasters.com/beans.jpg"'
        assert repair_image_sources(source) == (source, [])

    def test_it_reports_every_url_it_replaced(self) -> None:
        source = (
            'a: "https://images.x.example/1.jpg", b: "https://images.x.example/2.png"'
        )
        _, replaced = repair_image_sources(source)
        assert len(replaced) == 2


# --------------------------------------------------------------------------
# the backstop is actually WIRED — without this it could be perfectly tested
# and perfectly inert, which is how the brand-name guard was pinned too
# --------------------------------------------------------------------------


BAD_MOCK = f'export const heroData = {{ imageSrc: "{DOGFOOD_URL}" }};\n'


def _model_result(files: dict[str, str]) -> dict:
    return {
        "data": {
            "files": files,
            "sectionMeta": {"slug": "hero", "component": "Hero"},
        }
    }


def test_the_fan_out_write_path_repairs(tmp_path: Path) -> None:
    project = tmp_path / "run-a"
    write_section_files(
        str(project),
        route_slug="home",
        component="Hero",
        files={"src/pages/home/mock/Hero.data.ts": BAD_MOCK},
    )
    written = (project / "src" / "pages" / "home" / "mock" / "Hero.data.ts").read_text(
        encoding="utf-8"
    )
    assert DOGFOOD_URL not in written
    assert PLACEHOLDER_IMAGE_DATA_URI in written


def test_the_single_section_write_path_repairs(tmp_path: Path) -> None:
    """The other write path. write_section_output has its own file loop; when it
    did, a repair added to only one of the two would have left this green under
    fan-out and red in the skeleton — or the reverse."""
    project = tmp_path / "run-b"
    write_section_output.__wrapped__(
        str(project),
        _model_result({"src/pages/home/mock/Hero.data.ts": BAD_MOCK}),
        1,
        route_slug="home",
    )
    written = (project / "src" / "pages" / "home" / "mock" / "Hero.data.ts").read_text(
        encoding="utf-8"
    )
    assert DOGFOOD_URL not in written
    assert PLACEHOLDER_IMAGE_DATA_URI in written


def test_the_repair_is_announced_on_stdout(tmp_path: Path, capsys) -> None:
    """A silent repair hides a prompt that has stopped working — and this exact
    defect already shipped twice unnoticed. The run report captures stdout per
    node, so the warning is where an operator can find it."""
    write_files_repairing_images(
        str(tmp_path), {"src/pages/home/mock/Hero.data.ts": BAD_MOCK}
    )
    out = capsys.readouterr().out
    assert "warning" in out
    assert DOGFOOD_URL in out


def test_a_clean_section_is_written_byte_for_byte(tmp_path: Path, capsys) -> None:
    """The repair must be inert on output that was already correct: no rewrite,
    no warning. A normalizer that touches every file is a normalizer nobody can
    reason about."""
    clean = f'export const heroData = {{ imageSrc: "{PLACEHOLDER_IMAGE_DATA_URI}" }};\n'
    write_files_repairing_images(str(tmp_path), {"src/pages/home/mock/Hero.data.ts": clean})
    assert (tmp_path / "src" / "pages" / "home" / "mock" / "Hero.data.ts").read_text(
        encoding="utf-8"
    ) == clean
    assert capsys.readouterr().out == ""


# --------------------------------------------------------------------------
# C1's second backstop: a hoisted string const, inlined back to a literal
#
# The prompt half of the C1 fix cannot be tested by running it. This half can,
# and it is what makes the forbidden shape unshippable even when the model
# hoists anyway — which is the likely disobedience, because sharing a long
# repeated literal is what a competent programmer does everywhere else.
# --------------------------------------------------------------------------


HOISTED_MOCK = (
    "import type { TeamGridProps } from \"../sections/TeamGrid\";\n"
    "\n"
    f'const {HOISTED_CONST_NAME} = "{PLACEHOLDER_IMAGE_DATA_URI}";\n'
    "\n"
    "export const teamGridData: TeamGridProps = {\n"
    "  members: [\n"
    f'    {{ key: "a", photoSrc: {HOISTED_CONST_NAME}, photoAlt: "A" }},\n'
    f'    {{ key: "b", photoSrc: {HOISTED_CONST_NAME}, photoAlt: "B" }},\n'
    "  ],\n"
    "};\n"
)


class TestInlineHoistedStringConsts:
    def test_it_replaces_every_reference_with_the_literal(self) -> None:
        inlined_source, names = inline_hoisted_string_consts(HOISTED_MOCK)
        assert names == [HOISTED_CONST_NAME]
        # what the exporter needs: a quoted literal at each field, twice
        assert inlined_source.count(f'photoSrc: "{PLACEHOLDER_IMAGE_DATA_URI}"') == 2
        # and no identifier reference survives anywhere
        assert HOISTED_CONST_NAME not in inlined_source

    def test_it_removes_the_declaration_it_inlined(self) -> None:
        inlined_source, _ = inline_hoisted_string_consts(HOISTED_MOCK)
        assert f"const {HOISTED_CONST_NAME}" not in inlined_source
        # the rest of the file is otherwise intact
        assert "import type { TeamGridProps }" in inlined_source
        assert "export const teamGridData: TeamGridProps = {" in inlined_source

    def test_it_is_inert_on_a_file_that_already_uses_literals(self) -> None:
        clean = HOISTED_MOCK.replace(
            f'const {HOISTED_CONST_NAME} = "{PLACEHOLDER_IMAGE_DATA_URI}";\n', ""
        ).replace(HOISTED_CONST_NAME, f'"{PLACEHOLDER_IMAGE_DATA_URI}"')
        assert inline_hoisted_string_consts(clean) == (clean, [])

    def test_it_is_idempotent(self) -> None:
        once, _ = inline_hoisted_string_consts(HOISTED_MOCK)
        twice, names = inline_hoisted_string_consts(once)
        assert twice == once
        assert names == []

    def test_it_generalises_past_images(self) -> None:
        """The defect class is wider than images: a shared copy const breaks a
        TEXT edit on those nodes identically, because contract 7.1 rewrites the
        literal either way. The general rule is simpler than the special case."""
        source = 'const CTA = "Get started";\nexport const d = { label: CTA };\n'
        inlined_source, names = inline_hoisted_string_consts(source)
        assert names == ["CTA"]
        assert inlined_source == 'export const d = { label: "Get started" };\n'

    def test_it_leaves_an_exported_const_alone(self) -> None:
        """Removing an `export`ed declaration could break the section file's own
        import beside it — so an exported const is not eligible, and the field
        stays as it was rather than being made subtly wrong."""
        source = 'export const SHARED = "x";\nexport const d = { label: SHARED };\n'
        assert inline_hoisted_string_consts(source) == (source, [])

    def test_it_leaves_a_const_declared_inside_a_function_alone(self) -> None:
        """Anchored at column 0: a local binding is not a module const, and
        inlining one would be a rewrite of logic rather than of data."""
        source = 'function f() {\n  const local = "x";\n  return local;\n}\n'
        assert inline_hoisted_string_consts(source) == (source, [])

    def test_it_does_not_rewrite_the_name_inside_a_string_or_comment(self) -> None:
        """The identifier substitution walks TypeScript atoms, consuming comments
        and strings first — so a mention of the const's name in prose is prose."""
        source = (
            'const LOGO = "x";\n'
            "// LOGO is the brand mark\n"
            'export const d = { note: "set LOGO later", src: LOGO };\n'
        )
        inlined_source, names = inline_hoisted_string_consts(source)
        assert names == ["LOGO"]
        assert "// LOGO is the brand mark" in inlined_source
        assert '"set LOGO later"' in inlined_source
        assert 'src: "x"' in inlined_source

    def test_an_unreferenced_const_is_left_where_the_model_put_it(self) -> None:
        """This exists to make a REFERENCE compilable, not to tidy code."""
        source = 'const UNUSED = "x";\nexport const d = { label: "y" };\n'
        assert inline_hoisted_string_consts(source) == (source, [])


def test_the_write_funnel_inlines_a_hoisted_const_in_mock_data(tmp_path: Path, capsys) -> None:
    """The backstop is WIRED, not merely correct — the same thing that had to be
    pinned for the image repair and for the brand-name guard."""
    write_files_repairing_images(
        str(tmp_path), {"src/pages/about/mock/TeamGrid.data.ts": HOISTED_MOCK}
    )
    written = (tmp_path / "src" / "pages" / "about" / "mock" / "TeamGrid.data.ts").read_text(
        encoding="utf-8"
    )
    assert HOISTED_CONST_NAME not in written
    assert written.count(f'photoSrc: "{PLACEHOLDER_IMAGE_DATA_URI}"') == 2
    # announced, with the const named, for the same reason the image repair is
    out = capsys.readouterr().out
    assert HOISTED_CONST_NAME in out
    assert "7.1" in out


def test_the_write_funnel_leaves_a_component_file_alone(tmp_path: Path) -> None:
    """Scoped to mock data on purpose: that is the only file contract 7.1's text
    channel rewrites. A component's module const is ordinary code, and inlining
    it would be an unasked-for rewrite of the file a developer reads."""
    component = f'const CLASSES = "flex";\nexport default function S() {{ return CLASSES; }}\n'
    write_files_repairing_images(
        str(tmp_path), {"src/pages/about/sections/TeamGrid.tsx": component}
    )
    assert (tmp_path / "src" / "pages" / "about" / "sections" / "TeamGrid.tsx").read_text(
        encoding="utf-8"
    ) == component


@pytest.mark.parametrize(
    "rel_path,expected",
    [
        ("src/pages/home/mock/Hero.data.ts", True),
        ("src\\pages\\home\\mock\\Hero.data.ts", True),  # a model-authored key has arrived this way
        ("src/pages/home/sections/Hero.tsx", False),
        ("src/pages/home/mock/Hero.ts", False),
    ],
)
def test_which_files_the_inlining_applies_to(rel_path: str, expected: bool) -> None:
    assert is_mock_data_file(rel_path) is expected


# --------------------------------------------------------------------------
# I3: the SHELL was outside both halves of the fix
#
# The rule reached 28 SECTION archetypes and the repair reached the two SECTION
# write paths. `src/shell/` is neither — and a logo is the shell's most natural
# use of an image, so a broken one ships on EVERY page of every generated site,
# invisible to every gate (gate 2 collects `href` only; gate 3 matches hex/px).
# --------------------------------------------------------------------------


def test_the_shell_agent_is_told_the_image_rule() -> None:
    from orchestrator.shell_pipeline import SHELL_SYSTEM

    system = SHELL_SYSTEM.format(brand_name="Acme")
    assert PLACEHOLDER_IMAGE_DATA_URI in system
    assert "never resolve" in system.lower()
    assert "*.example" in system


def test_the_shell_write_path_repairs_an_unloadable_logo(tmp_path: Path, capsys) -> None:
    """The deterministic half for the shell. `write_shell` runs in the parent
    process, so the warning already lands on the stream the job result carries."""
    from orchestrator import shell_pipeline

    project = tmp_path / "run-shell"
    (project / "src" / "shell").mkdir(parents=True)
    nav = f'export default function Nav() {{ return <img src="{DOGFOOD_URL}" />; }}\n'

    # everything after the write is a subprocess (tsc, the gates CLI) and is not
    # what this test is about
    monkey = pytest.MonkeyPatch()
    try:
        monkey.setattr(shell_pipeline, "ensure_node_modules", lambda *a, **k: None)
        monkey.setattr(
            shell_pipeline,
            "run_project_typecheck",
            lambda *a, **k: type("P", (), {"returncode": 0, "stdout": ""})(),
        )
        monkey.setattr(
            shell_pipeline,
            "_run_compiler_cli",
            lambda *a, **k: type("P", (), {"stdout": json.dumps({"passed": True, "gates": []})})(),
        )
        shell_pipeline.write_shell.__wrapped__(
            str(project),
            "export const routes = [];\n",
            {"files": {"src/shell/Nav.tsx": nav}},
            1,
        )
    finally:
        monkey.undo()

    written = (project / "src" / "shell" / "Nav.tsx").read_text(encoding="utf-8")
    assert DOGFOOD_URL not in written
    assert PLACEHOLDER_IMAGE_DATA_URI in written
    assert "Nav.tsx" in capsys.readouterr().out
