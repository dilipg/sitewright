"""Shell Agent mechanics: deterministic routes.ts (the ground-truth route
table, contract section 2 — never model-authored, so it can never drift
from the plan) and shell-output validation (pipeline 2.4)."""

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
