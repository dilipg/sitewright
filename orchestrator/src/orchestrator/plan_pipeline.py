"""Intake Agent + Site Planner (pipeline 2.1/2.2, build prompt 5.1).

Intake normalizes a freeform brief into brief.json, asking AT MOST one round
of clarifying questions — enforced structurally: the follow-up call's tool
schema has no questions field, so a second round is impossible. The Planner
emits siteplan.json from the archetype catalog; a mechanical validator
enforces catalog membership, the custom budget, and landing priors, with the
same bounded-retry-with-report pattern as the section gates. The plan is the
cheapest correction point in the system: nothing downstream spends until the
user approves it.
"""

import json
from pathlib import Path

import kitaru
from kitaru import checkpoint, flow

from orchestrator.catalog import ARCHETYPE_CATALOG, CUSTOM_ARCHETYPE, PAGE_ARCHETYPES
from orchestrator.model_call import call_model_structured_impl
from orchestrator.runlog import append_run_event, default_run_log_path
from orchestrator.section_pipeline import GENERATED_DIR, MAX_ATTEMPTS, materialize

BRIEF_PROPERTIES = {
    "siteType": {"type": "string", "enum": ["landing", "marketing", "storefront", "saas-product"]},
    "brand": {
        "type": "object",
        "properties": {
            # F3 (round 1 live verification): this was a bare {"type": "string"}
            # and a brief naming no brand produced the literal "<UNKNOWN>",
            # which shell_pipeline.brand_scaffold then wrote into
            # `<title>` and, via brand_slug, into package.json's "name" -- both
            # shipped into the handover export while the generated nav showed a
            # real invented name. The model had no instruction for the case, so
            # it invented a placeholder instead of a brand.
            "name": {
                "type": "string",
                "description": (
                    "The brand/product name, exactly as it should appear in the browser tab "
                    "and the site header. If the brief does not name one, INVENT a specific, "
                    "plausible name that suits the brief and record that you did so in "
                    "assumptions. NEVER emit a placeholder such as <UNKNOWN>, UNKNOWN, TBD, "
                    "N/A, 'the brand' or 'Company Name': this string ships verbatim into the "
                    "exported site's <title> and package.json."
                ),
            },
            "tone": {"type": "string"},
            "audience": {"type": "string"},
            "oneLiner": {"type": "string"},
        },
        "required": ["name", "tone", "audience", "oneLiner"],
    },
    "creativity": {"type": "string", "enum": ["low"]},
    "contentHints": {"type": "array", "items": {"type": "string"}},
    "pagesRequested": {"type": "array", "items": {"type": "string"}},
    "constraints": {"type": "array", "items": {"type": "string"}},
    "assumptions": {"type": "array", "items": {"type": "string"}},
}

INTAKE_TOOL_FIRST = {
    "type": "object",
    "properties": {
        "clarifyingQuestions": {
            "type": "array",
            "items": {"type": "string"},
            "description": "ONLY when the brief has no discernible PURPOSE; one round max. A missing brand NAME is never grounds for a question -- invent one (see brand.name)",
        },
        "brief": {"type": "object", "properties": BRIEF_PROPERTIES, "required": list(BRIEF_PROPERTIES)},
    },
}

# follow-up round: structurally cannot ask again
INTAKE_TOOL_FOLLOWUP = {
    "type": "object",
    "properties": {
        "brief": {"type": "object", "properties": BRIEF_PROPERTIES, "required": list(BRIEF_PROPERTIES)}
    },
    "required": ["brief"],
}

PLANNER_TOOL = {
    "type": "object",
    "properties": {
        "routes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "slug": {"type": "string"},
                    "path": {"type": "string"},
                    "pageArchetype": {"type": "string", "enum": list(PAGE_ARCHETYPES)},
                    "title": {"type": "string"},
                    "sections": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "slug": {"type": "string"},
                                "archetype": {"type": "string"},
                                "brief": {"type": "string"},
                            },
                            "required": ["slug", "archetype", "brief"],
                        },
                    },
                },
                "required": ["slug", "path", "pageArchetype", "title", "sections"],
            },
        }
    },
    "required": ["routes"],
}

INTAKE_SYSTEM = (
    "You are the Intake Agent of an automated website generator. Normalize the "
    "user's freeform brief into the structured brief. Every downstream agent "
    "consumes only your output, never the raw text. creativity is always "
    '"low" in v1. If (and only if) the brief is too thin to plan a site — no '
    "discernible purpose — ask a SINGLE round of short "
    "clarifying questions instead of emitting the brief. Otherwise emit the "
    "brief directly; when you must assume something material, record it in "
    "assumptions (plain sentences shown to the user).\n\n"
    "A MISSING BRAND NAME IS NOT GROUNDS FOR A CLARIFYING QUESTION. Invent a "
    "specific, plausible name that suits the brief and record the invention in "
    "assumptions. Never emit a placeholder: brand.name ships verbatim into the "
    "exported site's <title> and package.json, and web-triggered generation has "
    "nobody to answer a question — a clarifying round there fails the whole run."
)

PLANNER_SYSTEM = (
    "You are the Site Planner of an automated website generator. From the "
    "normalized brief, decide the route map and, per route, a page archetype "
    "and an ordered section list.\n\n"
    "SECTION ARCHETYPE CATALOG (the only allowed values):\n"
    + "\n".join(f"- {name}: {blurb}" for name, blurb in ARCHETYPE_CATALOG.items())
    + "\n- custom: escape hatch when nothing fits; BUDGETED — at most one custom section per page.\n\n"
    "PAGE ARCHETYPE PRIORS:\n"
    + "\n".join(f"- {name}: {info['prior']}" for name, info in PAGE_ARCHETYPES.items())
    + "\n\nRules: the home route has path \"/\" and comes first; slugs are unique "
    "kebab-case; paths are unique and start with /; landing pages have 4-7 "
    "sections with hero first and cta-band last; section briefs are ONE "
    "sentence of intent; titles are nav-ready. 3-6 routes for a typical site "
    "unless the brief demands otherwise. The user approves this plan before "
    "any generation spend, so make it legible."
)


def validate_siteplan(plan: dict) -> list[str]:
    """Mechanical checks (pipeline 2.2 hard rule + 4.3 landing priors).
    Messages are injected into the planner's retry prompt."""
    issues: list[str] = []
    routes = plan.get("routes", [])
    if not routes:
        return ["plan has no routes"]

    slugs = [route["slug"] for route in routes]
    paths = [route["path"] for route in routes]
    for slug in {s for s in slugs if slugs.count(s) > 1}:
        issues.append(f'duplicate route slug "{slug}"')
    for path in {p for p in paths if paths.count(p) > 1}:
        issues.append(f'duplicate route path "{path}"')
    if "/" not in paths:
        issues.append('no home route: exactly one route must have path "/"')

    for route in routes:
        sections = route.get("sections", [])
        section_slugs = [section["slug"] for section in sections]
        for slug in {s for s in section_slugs if section_slugs.count(s) > 1}:
            issues.append(f'route "{route["slug"]}": duplicate section slug "{slug}"')

        customs = 0
        for section in sections:
            archetype = section["archetype"]
            if archetype == CUSTOM_ARCHETYPE:
                customs += 1
            elif archetype not in ARCHETYPE_CATALOG:
                issues.append(
                    f'route "{route["slug"]}": archetype "{archetype}" is not in the catalog'
                )
        if customs > 1:
            issues.append(
                f'route "{route["slug"]}": {customs} custom sections; the custom budget is at most 1 per page'
            )

        if route.get("pageArchetype") == "landing":
            prior = PAGE_ARCHETYPES["landing"]
            if not (prior["min_sections"] <= len(sections) <= prior["max_sections"]):
                issues.append(
                    f'route "{route["slug"]}": landing pages need 4-7 sections, got {len(sections)}'
                )
            if sections and sections[0]["archetype"] != prior["first"]:
                issues.append(f'route "{route["slug"]}": a landing page starts with a hero section')
            if sections and sections[-1]["archetype"] != prior["last"]:
                issues.append(f'route "{route["slug"]}": a landing page ends with a cta-band section')
    return issues


def require_plan_approval(project_dir: str | Path) -> None:
    """Generation-spend gate: an existing plan must be approved. Projects
    without a plan directory (canned-brief skeleton runs) are exempt."""
    status_path = Path(project_dir) / "plan" / "plan-status.json"
    if not status_path.parent.exists():
        return
    approved = False
    if status_path.exists():
        approved = json.loads(status_path.read_text(encoding="utf-8")).get("approved") is True
    if not approved:
        raise SystemExit(
            f"The plan in {status_path.parent} has not been approved. Approve it in the "
            "editor (or set plan-status.json approved=true) before spending on generation."
        )


# ---------- checkpointed steps ----------


#: Brand names that must never reach `shell_pipeline.brand_scaffold`, which
#: writes this string into the exported `<title>` and (slugged) into
#: package.json's "name". Lowercased for comparison. `acme` is deliberately
#: ABSENT: it is a perfectly plausible invented brand, and the fixture's own
#: "Acme Analytics" is a legitimate name rather than a placeholder.
PLACEHOLDER_BRAND_NAMES = frozenset(
    {
        "",
        "unknown",
        "n/a",
        "na",
        "tbd",
        "tba",
        "placeholder",
        "none",
        "null",
        "undefined",
        "brand",
        "the brand",
        "your brand",
        "brand name",
        "company",
        "company name",
        "your company",
        "site",
        "website",
        "untitled",
        "example",
    }
)


def assert_brand_name_usable(name: object) -> None:
    """Refuse a placeholder brand name at the CHEAPEST possible stage.

    F3, found by round 1's live verification: intake emitted the literal
    ``"<UNKNOWN>"`` for a brief that named no brand, and every downstream stage
    faithfully carried it until it shipped as ``<title>&lt;UNKNOWN&gt;</title>``
    and ``"name": "unknown"`` inside a handover export — the product's one
    stated promise being developer-handover quality.

    Raising here costs the price of the intake call (~$0.003, measured) instead
    of a whole ~$1.74 generation that ends in a visibly broken artifact. With
    the prompt and schema guidance added alongside this, it should essentially
    never fire; it exists so that a model that ignores them cannot ship, rather
    than as the mechanism for getting a name.

    Angle brackets are rejected on sight, whatever they contain: no real brand
    name carries them, and ``<UNKNOWN>``-shaped inventions are exactly the
    failure observed.
    """
    if not isinstance(name, str):
        raise ValueError(f"brand.name must be a string, got {type(name).__name__}")
    stripped = name.strip()
    if "<" in stripped or ">" in stripped:
        raise ValueError(
            f"brand.name {stripped!r} looks like a placeholder (angle brackets); it would ship "
            "into the exported <title> and package.json"
        )
    if stripped.lower() in PLACEHOLDER_BRAND_NAMES:
        raise ValueError(
            f"brand.name {stripped!r} is a placeholder; it would ship into the exported "
            "<title> and package.json. Intake must invent a specific name instead."
        )


@checkpoint
def intake_step(run_id: str, user_brief: str, clarification_answers: str) -> dict:
    followup = bool(clarification_answers)
    user = (
        f"User brief:\n{user_brief}"
        if not followup
        else (
            f"User brief:\n{user_brief}\n\nYour clarifying questions were answered as "
            f"follows (proceed now; record remaining unknowns as assumptions):\n{clarification_answers}"
        )
    )
    result = call_model_structured_impl(
        role="intake",
        system=INTAKE_SYSTEM,
        user=user,
        tool_name="emit_intake",
        tool_description="Emit the normalized brief, or one round of clarifying questions.",
        tool_schema=INTAKE_TOOL_FOLLOWUP if followup else INTAKE_TOOL_FIRST,
        max_tokens=2048,
    )
    append_run_event(
        default_run_log_path(run_id),
        run_id=run_id,
        event_type="intake.complete",
        model=result["model"],
        usage=result["usage"],
        duration_s=result.get("duration_s"),
        raw_output=json.dumps(result["data"], indent=2),
        checkpoint_ref=f"{kitaru.current_execution_id()}/intake_step",
    )
    # Validated AFTER the run-log append, deliberately: a refused brand name is
    # a model-output problem, and the raw output that caused it must be on the
    # record before the raise, or the failure is undiagnosable from the log.
    # Only when a brief was actually emitted -- a clarifying-questions response
    # legitimately carries no brand at all.
    brief = result["data"].get("brief")
    if isinstance(brief, dict):
        assert_brand_name_usable(brief.get("brand", {}).get("name"))
    return result["data"]


@checkpoint
def planner_step(run_id: str, brief: dict, attempt: int, failure_report: str) -> dict:
    user = f"Normalized brief:\n{json.dumps(brief, indent=2)}"
    if failure_report:
        user += (
            "\n\nPREVIOUS PLAN FAILED VALIDATION. Fix every issue and emit the corrected plan:\n"
            + failure_report
        )
    result = call_model_structured_impl(
        role="planner",
        system=PLANNER_SYSTEM,
        user=user,
        tool_name="emit_siteplan",
        tool_description="Emit the site plan: routes with page archetypes and ordered section lists.",
        tool_schema=PLANNER_TOOL,
        max_tokens=4096,
    )
    append_run_event(
        default_run_log_path(run_id),
        run_id=run_id,
        event_type="plan.complete",
        attempt=attempt,
        model=result["model"],
        usage=result["usage"],
        duration_s=result.get("duration_s"),
        raw_output=json.dumps(result["data"], indent=2),
        checkpoint_ref=f"{kitaru.current_execution_id()}/planner_step#a{attempt}",
    )
    return result["data"]


@checkpoint
def write_plan_files(run_id: str, brief: dict, siteplan: dict) -> str:
    plan_dir = GENERATED_DIR / run_id / "plan"
    plan_dir.mkdir(parents=True, exist_ok=True)
    (plan_dir / "brief.json").write_text(json.dumps(brief, indent=2) + "\n", encoding="utf-8")
    (plan_dir / "siteplan.json").write_text(json.dumps(siteplan, indent=2) + "\n", encoding="utf-8")
    (plan_dir / "plan-status.json").write_text(
        json.dumps({"approved": False}, indent=2) + "\n", encoding="utf-8"
    )
    return str(plan_dir)


# ---------- the flow ----------


@flow
def plan_flow(run_id: str, user_brief: str, clarification_answers: str = "") -> dict:
    print(f"exec_id: {kitaru.current_execution_id()}", flush=True)

    intake = materialize(intake_step(run_id, user_brief, clarification_answers))
    if intake.get("clarifyingQuestions") and not intake.get("brief"):
        return {"needsClarification": True, "questions": intake["clarifyingQuestions"]}
    brief = intake["brief"]

    failure_report = ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        siteplan = materialize(planner_step(run_id, brief, attempt, failure_report))
        issues = validate_siteplan(siteplan)
        if not issues:
            plan_dir = materialize(write_plan_files(run_id, brief, siteplan))
            return {
                "needsClarification": False,
                "planDir": plan_dir,
                "attempts": attempt,
                "routes": [route["slug"] for route in siteplan["routes"]],
            }
        failure_report = "\n".join(f"- {issue}" for issue in issues)

    return {"needsClarification": False, "failed": True, "failureReport": failure_report}
