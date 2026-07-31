import json
"""Shell Agent mechanics: deterministic routes.ts (the ground-truth route
table, contract section 2 — never model-authored, so it can never drift
from the plan) and shell-output validation (pipeline 2.4)."""

from pathlib import Path

from orchestrator.shell_pipeline import build_routes_ts, validate_shell_output

ROUTES = [
    {"slug": "home", "path": "/", "title": "Home"},
    {"slug": "pricing", "path": "/pricing", "title": "Pricing"},
]


def test_routes_ts_enumerates_every_route_exactly() -> None:
    source = build_routes_ts(ROUTES)
    assert '{ slug: "home", path: "/", title: "Home" }' in source
    assert '{ slug: "pricing", path: "/pricing", title: "Pricing" }' in source
    assert "export const routes" in source
    assert "RouteDef" in source


def test_routes_ts_is_deterministic() -> None:
    assert build_routes_ts(ROUTES) == build_routes_ts(ROUTES)


def test_shell_output_must_be_exactly_three_files() -> None:
    files = {
        "src/shell/AppShell.tsx": "x",
        "src/shell/Nav.tsx": "x",
        "src/shell/Footer.tsx": "x",
    }
    assert validate_shell_output(files) == []

    missing = {k: v for k, v in files.items() if k != "src/shell/Footer.tsx"}
    assert any("Footer" in issue for issue in validate_shell_output(missing))

    stray = dict(files) | {"src/shell/routes.ts": "x"}  # routes.ts is deterministic, not agent-authored
    issues = validate_shell_output(stray)
    assert any("routes.ts" in issue for issue in issues)

    outside = dict(files) | {"src/pages/home/hack.tsx": "x"}
    issues = validate_shell_output(outside)
    assert any("src/pages/home/hack.tsx" in issue for issue in issues)


# ---------- scaffold branding (6.4 handover-trial finding) ----------


def test_brand_slug_produces_an_npm_safe_name() -> None:
    from orchestrator.shell_pipeline import brand_slug

    assert brand_slug("Tidewrack Supply") == "tidewrack-supply"
    assert brand_slug("Bloom & Root") == "bloom-root"
    assert brand_slug("  ") == "generated-site"


def test_brand_scaffold_replaces_the_fixture_identity(tmp_path: Path) -> None:
    """Every generated project is copied from the fixture, so without this the
    handover ships a browser tab reading "Acme Analytics" and a package named
    "acme-landing-fixture" on someone else's site (6.4 trial finding)."""
    from orchestrator.shell_pipeline import brand_scaffold

    (tmp_path / "index.html").write_text(
        "<html><head><title>Acme Analytics</title></head><body></body></html>", encoding="utf-8"
    )
    (tmp_path / "package.json").write_text(
        json.dumps({"name": "acme-landing-fixture", "version": "0.0.0", "scripts": {"build": "x"}}),
        encoding="utf-8",
    )

    changed = brand_scaffold(str(tmp_path), "Tidewrack Supply")

    assert sorted(changed) == ["index.html", "package.json"]
    assert "<title>Tidewrack Supply</title>" in (tmp_path / "index.html").read_text(encoding="utf-8")
    package = json.loads((tmp_path / "package.json").read_text(encoding="utf-8"))
    assert package["name"] == "tidewrack-supply"
    # everything else in package.json survives
    assert package["scripts"] == {"build": "x"}


def test_brand_scaffold_escapes_html_in_the_brand_name(tmp_path: Path) -> None:
    from orchestrator.shell_pipeline import brand_scaffold

    (tmp_path / "index.html").write_text("<title>old</title>", encoding="utf-8")
    brand_scaffold(str(tmp_path), 'Ben & Jerry <script>alert(1)</script>')
    branded = (tmp_path / "index.html").read_text(encoding="utf-8")
    assert "<script>" not in branded
    assert "&amp;" in branded


def test_brand_scaffold_is_idempotent_and_tolerates_missing_files(tmp_path: Path) -> None:
    from orchestrator.shell_pipeline import brand_scaffold

    # nothing to brand: must not raise
    assert brand_scaffold(str(tmp_path), "Tidewrack Supply") == []

    (tmp_path / "index.html").write_text("<title>Acme</title>", encoding="utf-8")
    assert brand_scaffold(str(tmp_path), "Tidewrack Supply") == ["index.html"]
    # already branded: reports no change on a second pass
    assert brand_scaffold(str(tmp_path), "Tidewrack Supply") == []
