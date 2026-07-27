"""Design System Agent mechanics: token-schema validation, the fixed
15-primitive file set, static specs, and the deterministic gallery."""

import json

from orchestrator.design_pipeline import (
    PRIMITIVE_SPECS,
    build_gallery_source,
    validate_primitive_output,
    validate_tokens_json,
)
from orchestrator.fixture_context import fixture_tokens


def test_fixture_tokens_validate_clean() -> None:
    assert validate_tokens_json(fixture_tokens()) == []


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
