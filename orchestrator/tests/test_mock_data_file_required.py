"""A section must ship the mock data file the page assembler will import.

FROM A REAL RUN. `home.sticky-hero` returned `files` containing only
`src/pages/home/sections/StickyHero.tsx` — no `mock/StickyHero.data.ts`. The
consequences, all recorded from that run's own log:

    section.validated  {"passed": true, "failures": []}
    manifest           7 node ids registered for home.sticky-hero
    run                reported success
    the site           Failed to resolve import "./mock/StickyHero.data"

WHY EVERY GATE PASSED, which is the interesting half. Gate 1 does run the
project's own `tsc --noEmit`, and a missing module IS a type error — but nothing
imported the file yet. `index.tsx` is written only after every section finishes,
and a section component takes its data as props, so `StickyHero.tsx` in
isolation typechecks perfectly. The broken import is manufactured LATER by the
deterministic assembler out of the section list. A section validated alone
cannot see that a two-file pair is half present.

That is why this check lives at output-acceptance time and asserts against the
filename the assembler is GOING to emit, rather than anything on disk.
"""

from __future__ import annotations

from orchestrator.section_pipeline import validate_mock_data_file

COMPONENT_SOURCE = 'import Container from "../../../primitives/Container";\n'
DATA_SOURCE = "export const stickyHeroData = { headline: 'Ship faster' };\n"


def result(files: dict[str, str], component: str = "StickyHero") -> dict:
    """The `model_result` shape the retry loop passes in."""
    return {"data": {"sectionMeta": {"slug": "sticky-hero", "component": component}, "files": files}}


def test_the_exact_payload_from_the_real_run_is_refused() -> None:
    """The component alone, which is what the model actually returned."""
    failure = validate_mock_data_file(
        result({"src/pages/home/sections/StickyHero.tsx": COMPONENT_SOURCE}), "home"
    )
    assert failure != "", (
        "the payload that shipped a broken site through every gate was accepted; "
        "a $1 run would report success and produce an unopenable page"
    )
    # The report is the model's only feedback on a retry, so it must name the
    # exact path rather than merely complain.
    assert "src/pages/home/mock/StickyHero.data.ts" in failure
    assert "stickyHeroData" in failure


def test_a_complete_pair_is_accepted() -> None:
    assert (
        validate_mock_data_file(
            result(
                {
                    "src/pages/home/sections/StickyHero.tsx": COMPONENT_SOURCE,
                    "src/pages/home/mock/StickyHero.data.ts": DATA_SOURCE,
                }
            ),
            "home",
        )
        == ""
    )


def test_backslash_keys_are_accepted() -> None:
    """A model-authored key has arrived with backslashes before, so a
    correct-but-backslashed pair must not be refused as missing (the same
    reason `is_mock_data_file` normalises)."""
    assert (
        validate_mock_data_file(
            result(
                {
                    "src\\pages\\home\\sections\\StickyHero.tsx": COMPONENT_SOURCE,
                    "src\\pages\\home\\mock\\StickyHero.data.ts": DATA_SOURCE,
                }
            ),
            "home",
        )
        == ""
    )


def test_a_case_mismatched_filename_is_refused() -> None:
    """`stickyHero.data.ts` resolves on Windows and breaks in the container.

    Refusing it here is what stops a site that works on the developer's machine
    from failing in Docker — the class `portable.py` exists because of.
    """
    failure = validate_mock_data_file(
        result(
            {
                "src/pages/home/sections/StickyHero.tsx": COMPONENT_SOURCE,
                "src/pages/home/mock/stickyHero.data.ts": DATA_SOURCE,
            }
        ),
        "home",
    )
    assert failure != "", "a case-mismatched mock filename was accepted"


def test_a_mock_file_for_a_DIFFERENT_section_does_not_satisfy_it() -> None:
    """The check is for THIS component's file, not "some mock file present".

    Under fan-out a page has many sections, so a loose `"/mock/" in key` test
    would be satisfied by a sibling's data file and let the gap straight
    through.
    """
    failure = validate_mock_data_file(
        result(
            {
                "src/pages/home/sections/StickyHero.tsx": COMPONENT_SOURCE,
                "src/pages/home/mock/Features.data.ts": "export const featuresData = {};\n",
            }
        ),
        "home",
    )
    assert failure != ""


def test_the_wrong_route_directory_is_refused() -> None:
    """A path under another route is not this section's file, and writing it
    would also violate the ownership map (contract section 2: a page agent
    writes only inside its own route)."""
    failure = validate_mock_data_file(
        result(
            {
                "src/pages/home/sections/StickyHero.tsx": COMPONENT_SOURCE,
                "src/pages/about/mock/StickyHero.data.ts": DATA_SOURCE,
            }
        ),
        "home",
    )
    assert failure != ""


def test_the_right_file_exporting_the_wrong_symbol_is_refused() -> None:
    """Same blind spot, same cost: the assembler imports a specific binding,
    and nothing would notice until the page was assembled."""
    failure = validate_mock_data_file(
        result(
            {
                "src/pages/home/sections/StickyHero.tsx": COMPONENT_SOURCE,
                "src/pages/home/mock/StickyHero.data.ts": "export const heroData = {};\n",
            }
        ),
        "home",
    )
    assert failure != ""
    assert "stickyHeroData" in failure


def test_no_files_at_all_is_refused_without_raising() -> None:
    """Tool-use does not hard-enforce the schema (the lesson `sectionMeta`'s own
    defensive accessor was added for), so an empty mapping must produce a clean
    report rather than an exception that escapes the retry loop."""
    failure = validate_mock_data_file(result({}), "home")
    assert failure != ""


def test_the_route_slug_is_honoured() -> None:
    """Fan-out runs one worker per route; the expected path must follow the
    route being generated, not a hardcoded `home`."""
    assert (
        validate_mock_data_file(
            result(
                {
                    "src/pages/pricing/sections/StickyHero.tsx": COMPONENT_SOURCE,
                    "src/pages/pricing/mock/StickyHero.data.ts": DATA_SOURCE,
                }
            ),
            "pricing",
        )
        == ""
    )
