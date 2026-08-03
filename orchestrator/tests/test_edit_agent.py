"""The edit agent. The model call is stubbed throughout — what is testable here
is the schema we ask for, how a response is interpreted, and when we escalate."""

import json
from pathlib import Path

from orchestrator import edit_agent
from orchestrator.config import ORCHESTRATOR_ROOT


def project(tmp_path: Path) -> Path:
    directory = tmp_path / "generated" / "run"
    (directory / "src" / "tokens").mkdir(parents=True)
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "version": 1,
                "nodes": {
                    "home.hero.headline": {
                        "route": "/", "file": "src/pages/home/sections/Hero.tsx",
                        "component": "Hero", "element": "Heading",
                        "editable": ["text", "style"], "status": "active",
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    (directory / "src" / "tokens" / "tokens.json").write_text(
        json.dumps({"color": {"semantic": {"accent": "#4f46e5"}}}), encoding="utf-8"
    )
    return directory


def stub(monkeypatch, responses: list[dict]) -> list[str]:
    """Replaces the model call with a scripted sequence; records roles used."""
    roles: list[str] = []

    def fake(**kwargs):
        roles.append(kwargs["role"])
        return {"data": responses[len(roles) - 1], "model": "stub", "usage": {}}

    monkeypatch.setattr(edit_agent, "call_model_structured_impl", fake)
    return roles


def test_operations_are_returned_as_given(tmp_path, monkeypatch) -> None:
    directory = project(tmp_path)
    monkeypatch.setattr(edit_agent, "GENERATED_DIR", directory.parent)
    stub(monkeypatch, [{"operations": [{"op": "text", "nodeId": "home.hero.headline", "value": "Shorter"}], "notes": "ok"}])

    result = edit_agent.resolve_edit("run", "home", "shorten the headline")
    assert result["operations"] == [{"op": "text", "nodeId": "home.hero.headline", "value": "Shorter"}]
    assert result["clarify"] is None
    assert result["structural"] is None


def test_the_mid_tier_runs_first(tmp_path, monkeypatch) -> None:
    directory = project(tmp_path)
    monkeypatch.setattr(edit_agent, "GENERATED_DIR", directory.parent)
    roles = stub(monkeypatch, [{"operations": [{"op": "visibility", "nodeId": "home.hero.headline", "hidden": True}], "notes": "ok"}])

    edit_agent.resolve_edit("run", "home", "hide the headline")
    assert roles == ["edit"], "no escalation when the first call resolves"


def test_an_empty_result_escalates_once(tmp_path, monkeypatch) -> None:
    """Escalation is for instructions the cheap tier could not resolve — not a
    retry loop. Exactly one, then report."""
    directory = project(tmp_path)
    monkeypatch.setattr(edit_agent, "GENERATED_DIR", directory.parent)
    roles = stub(
        monkeypatch,
        [
            {"operations": [], "notes": "could not resolve"},
            {"operations": [{"op": "text", "nodeId": "home.hero.headline", "value": "Shorter"}], "notes": "ok"},
        ],
    )

    result = edit_agent.resolve_edit("run", "home", "make it feel calmer")
    assert roles == ["edit", "edit-escalated"]
    assert len(result["operations"]) == 1


def test_a_clarify_response_does_NOT_escalate(tmp_path, monkeypatch) -> None:
    """Asking a question is a successful outcome, not a failure to resolve.
    Escalating would pay the top tier to ask the same question again."""
    directory = project(tmp_path)
    monkeypatch.setattr(edit_agent, "GENERATED_DIR", directory.parent)
    roles = stub(monkeypatch, [{"operations": [], "clarify": "which button?", "notes": "ambiguous"}])

    result = edit_agent.resolve_edit("run", "home", "make the button green")
    assert roles == ["edit"]
    assert result["clarify"] == "which button?"


def test_a_structural_response_does_NOT_escalate(tmp_path, monkeypatch) -> None:
    directory = project(tmp_path)
    monkeypatch.setattr(edit_agent, "GENERATED_DIR", directory.parent)
    roles = stub(
        monkeypatch,
        [{"operations": [], "structural": {"kind": "add-section", "route": "home", "archetype": "social-proof", "reason": "needs generation"}, "notes": "structural"}],
    )

    result = edit_agent.resolve_edit("run", "home", "add a testimonials section")
    assert roles == ["edit"]
    assert result["structural"]["kind"] == "add-section"


def test_both_escalation_attempts_failing_reports_rather_than_raising(tmp_path, monkeypatch) -> None:
    directory = project(tmp_path)
    monkeypatch.setattr(edit_agent, "GENERATED_DIR", directory.parent)
    stub(monkeypatch, [{"operations": [], "notes": "no"}, {"operations": [], "notes": "no"}])

    result = edit_agent.resolve_edit("run", "home", "???")
    assert result["operations"] == []
    assert result["clarify"] is not None, "the user gets a sentence, not silence"


def test_the_tool_schema_constrains_style_to_the_projects_own_tokens(tmp_path) -> None:
    """The fidelity guarantee: 'green' can only become a token path that exists
    in this project, never a raw colour."""
    schema = edit_agent.build_tool_schema(["color.semantic.accent", "color.semantic.bg"])
    style = next(
        variant for variant in schema["properties"]["operations"]["items"]["anyOf"]
        if variant["properties"]["op"]["const"] == "style"
    )
    assert style["properties"]["token"]["enum"] == ["color.semantic.accent", "color.semantic.bg"]


def _variant(schema: dict, op: str) -> dict:
    return next(
        variant for variant in schema["properties"]["operations"]["items"]["anyOf"]
        if variant["properties"]["op"]["const"] == op
    )


def test_the_tool_schema_constrains_property_to_what_the_exporter_can_compile() -> None:
    """`property` was an open string, so `fontFamily` was askable, validated,
    rendered in the preview — and then killed the export. The enum makes the
    unexportable unrepresentable, one layer earlier than validation."""
    schema = edit_agent.build_tool_schema(["color.semantic.accent"])
    for op in ("style", "styleExact", "layout"):
        enum = _variant(schema, op)["properties"]["property"]["enum"]
        assert "color" in enum, op
        assert "padding" in enum, op
        assert "fontFamily" not in enum, op
        assert "opacity" not in enum, op
        assert "borderColor" not in enum, op


def test_the_property_enum_IS_the_compilers_list_not_a_copy_of_it() -> None:
    """Three modules have to agree about what is representable (the exporter's
    utility table, the editor's validation, this schema). They agree by reading
    one file; this test is what keeps that true."""
    shared = json.loads(
        (ORCHESTRATOR_ROOT.parent / "compiler" / "src" / "style-properties.json").read_text(
            encoding="utf-8"
        )
    )
    schema = edit_agent.build_tool_schema(["color.semantic.accent"])
    assert _variant(schema, "style")["properties"]["property"]["enum"] == list(shared)
