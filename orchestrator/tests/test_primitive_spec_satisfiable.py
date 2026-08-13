"""The primitive spec must not demand something React's types forbid.

A live generation died at the design stage with

    Icon.tsx(164,7): error TS2322: Property 'draggable' does not exist on
    type 'SVGProps<SVGSVGElement>'

— ~$1.00 spent, 0 of 18 sections generated. The model had done exactly what it
was told: `_COMMON` said to forward `draggable` "verbatim to the root element",
and `Icon` is specified as "inline SVG". React's `SVGProps` declares neither
`draggable` nor `title`, so the instruction was **unsatisfiable** for the one
primitive whose root is an `<svg>`.

Retrying could never have fixed it — each attempt re-derives the same impossible
requirement — which is what makes this worth a test rather than a comment: the
failure mode is an expensive, deterministic loop, and it is invisible until a
real generation reaches the design stage.

These are cheap text assertions, not a typecheck of generated output. They
cannot prove the spec is satisfiable in general; they pin the specific
contradiction that was measured, and the guidance that resolves it.
"""

from __future__ import annotations

from orchestrator.design_pipeline import _COMMON, PRIMITIVE_SPECS

#: Props React's `SVGProps` does NOT declare, verified empirically against the
#: repo's own @types/react: a probe assigning each of these from
#: `SVGProps<SVGSVGElement>` fails to compile for exactly these two, while
#: `tabIndex`, `role`, `onClick` and the drag handlers compile fine.
NOT_ON_SVG_PROPS = ("draggable", "title")


def test_common_still_asks_for_the_props_that_broke_it() -> None:
    """Guards the premise, so the tests below cannot pass vacuously.

    If the passthrough list stopped mentioning these, the assertions below would
    be checking guidance for a requirement that no longer exists — green, and
    meaningless.
    """
    for prop in NOT_ON_SVG_PROPS:
        assert prop in _COMMON


def test_common_tells_the_agent_to_declare_passthrough_props_explicitly() -> None:
    """The resolution: declare them on the primitive's own props type.

    Relying on the element's prop type is what fails, because `SVGProps` lacks
    two of the props the spec mandates.
    """
    lowered = _COMMON.lower()
    assert "declare each passthrough prop explicitly" in lowered
    # And it must say WHY, naming the type that lacks them — an unexplained
    # "declare these explicitly" reads as style advice and gets ignored.
    assert "svgprops" in lowered


def test_the_svg_primitive_is_still_the_one_at_risk() -> None:
    """`Icon` is the primitive whose root is an <svg>.

    If another SVG-rooted primitive is added, this test is where its author
    finds out that the same contradiction applies to it.
    """
    icon = PRIMITIVE_SPECS["Icon"]
    assert "inline SVG" in icon
    # The spec is composed of the per-primitive text plus _COMMON, so the
    # guidance must actually reach Icon's prompt rather than living somewhere
    # the agent never sees.
    assert "declare each passthrough prop explicitly" in icon.lower()
