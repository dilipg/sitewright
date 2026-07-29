"""Design System Agent mechanics: token-schema validation, the fixed
15-primitive file set, static specs, and the deterministic gallery."""

import json

from orchestrator.design_pipeline import (
    PRIMITIVE_SPECS,
    PRIMITIVES_TOOL,
    TOKENS_TOOL,
    _COLOR_STEPS,
    _RADIUS_KEYS,
    _SCALE_KEYS,
    _SEMANTIC_KEYS,
    _SHADOW_KEYS,
    _SPACE_KEYS,
    _BREAKPOINT_KEYS,
    build_gallery_source,
    validate_primitive_output,
    validate_tokens_json,
)
from orchestrator.fixture_context import fixture_tokens


def test_fixture_tokens_validate_clean() -> None:
    assert validate_tokens_json(fixture_tokens()) == []


def test_tokens_tool_schema_fully_specifies_required_sections() -> None:
    # Live-observed: a bare {"type": "object"} for "tokens" (no nested
    # properties/required) is schema-valid for an EMPTY object under
    # Gemini's response_json_schema structured-output mode -- unlike
    # Claude's forced-tool-use, which leans on the system prompt's prose
    # description instead of the schema's own strictness. Gemini took the
    # minimal-effort path and returned {"tokens": {}} on all 3 attempts,
    # every time, against a real brief. The schema must fully specify every
    # section validate_tokens_json() checks, so an empty object is no
    # longer schema-valid on ANY provider.
    tokens_schema = TOKENS_TOOL["properties"]["tokens"]
    assert tokens_schema["type"] == "object"
    top_level_required = set(tokens_schema["required"])
    assert {"color", "typography", "space", "radius", "shadow", "breakpoint"} <= top_level_required

    color_schema = tokens_schema["properties"]["color"]
    assert set(color_schema["required"]) == {"primary", "neutral", "semantic"}
    assert set(color_schema["properties"]["primary"]["required"]) == set(_COLOR_STEPS)
    assert set(color_schema["properties"]["semantic"]["required"]) == set(_SEMANTIC_KEYS)

    typography_schema = tokens_schema["properties"]["typography"]
    assert set(typography_schema["required"]) == {"fontFamily", "scale", "weight", "leading"}
    assert set(typography_schema["properties"]["scale"]["required"]) == set(_SCALE_KEYS)

    assert set(tokens_schema["properties"]["space"]["required"]) == set(_SPACE_KEYS)
    assert set(tokens_schema["properties"]["radius"]["required"]) == set(_RADIUS_KEYS)
    assert set(tokens_schema["properties"]["shadow"]["required"]) == set(_SHADOW_KEYS)
    assert set(tokens_schema["properties"]["breakpoint"]["required"]) == set(_BREAKPOINT_KEYS)


def test_primitives_tool_schema_requires_every_expected_file() -> None:
    # Same class of gap as the tokens schema: "files": {"type": "object",
    # additionalProperties: {"type": "string"}} with no "required" list lets
    # an empty {} satisfy the schema. Every one of the 15 fixed primitive
    # files must be individually required.
    files_schema = PRIMITIVES_TOOL["properties"]["files"]
    expected_paths = {f"src/primitives/{name}.tsx" for name in PRIMITIVE_SPECS}
    assert set(files_schema["required"]) == expected_paths
    assert set(files_schema["properties"]) == expected_paths


def test_token_validator_names_missing_pieces() -> None:
    tokens = fixture_tokens()
    del tokens["color"]["semantic"]["accent"]
    issues = validate_tokens_json(tokens)
    assert any("accent" in issue for issue in issues)

    tokens = fixture_tokens()
    del tokens["typography"]["scale"]["5xl"]
    assert any("5xl" in issue for issue in validate_tokens_json(tokens))

    tokens = fixture_tokens()
    del tokens["color"]["primary"]["600"]
    assert any("600" in issue for issue in validate_tokens_json(tokens))

    tokens = fixture_tokens()
    del tokens["breakpoint"]
    assert any("breakpoint" in issue for issue in validate_tokens_json(tokens))


def test_primitive_specs_cover_the_contract_set() -> None:
    assert set(PRIMITIVE_SPECS) == {
        "Button", "Card", "Input", "Textarea", "Select", "Badge", "Heading", "Text",
        "Link", "Image", "Container", "Grid", "Stack", "Divider", "Icon",
    }
    for spec in PRIMITIVE_SPECS.values():
        assert "nodeId" in spec  # every spec restates the passthrough rule


def test_primitive_output_must_be_exactly_the_fifteen_files() -> None:
    files = {f"src/primitives/{name}.tsx": "export {}" for name in PRIMITIVE_SPECS}
    inventory = [f"{name}(...)" for name in PRIMITIVE_SPECS]
    assert validate_primitive_output(files, inventory) == []

    missing = dict(files)
    del missing["src/primitives/Icon.tsx"]
    assert any("Icon" in issue for issue in validate_primitive_output(missing, inventory))

    stray = dict(files) | {"src/pages/home/hack.tsx": "x"}
    issues = validate_primitive_output(stray, inventory)
    assert any("src/pages/home/hack.tsx" in issue for issue in issues)

    assert any("inventory" in issue for issue in validate_primitive_output(files, []))


def test_gallery_exercises_every_primitive() -> None:
    source = build_gallery_source()
    for name in PRIMITIVE_SPECS:
        assert f"<{name}" in source, f"gallery must render {name}"
        assert f'from "../../primitives/{name}"' in source
    # gallery is dev-only eyeball material: no node ids, so it stays out of
    # the manifest's jurisdiction
    assert "data-node-id" not in source
    assert "nodeId" not in source
