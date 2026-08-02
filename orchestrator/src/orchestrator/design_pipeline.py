"""Design System Agent (pipeline 2.3, build prompt 5.2): two checkpointed
steps — tokens, then the primitive set (contract 4.1 defines a MINIMUM set;
4.2 reserves ADDING to it to this agent, so the set is closed per-run but not
forever — `Notice` was added in 7.4) generated
against static per-primitive specs (constrained fill-in, not open
generation). Generated tokens flow through the M1 deriver; generated
primitives must typecheck and pass gates, both with bounded retry. A
deterministic gallery page renders every primitive for eyeball review.
"""

import json
import shutil
import subprocess
from pathlib import Path

import kitaru
from kitaru import checkpoint, flow

from orchestrator.design_context import build_design_context
from orchestrator.model_call import call_model_structured_impl
from orchestrator.runlog import append_run_event, default_run_log_path
from orchestrator.section_pipeline import (
    COMPILER_DIR,
    GENERATED_DIR,
    MAX_ATTEMPTS,
    _run_compiler_cli,
    materialize,
    prepare_workspace,
)

# ---------- token schema validation (contract 3.1) ----------

_COLOR_STEPS = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900"]
_SEMANTIC_KEYS = ["bg", "surface", "text", "textMuted", "accent", "accentContrast", "border", "danger", "success"]
_SCALE_KEYS = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl"]
_WEIGHT_KEYS = ["regular", "medium", "semibold", "bold"]
_LEADING_KEYS = ["tight", "snug", "normal", "relaxed"]
_SPACE_KEYS = ["0", "1", "2", "3", "4", "6", "8", "12", "16", "24"]
_RADIUS_KEYS = ["none", "sm", "md", "lg", "full"]
_SHADOW_KEYS = ["sm", "md", "lg"]
_BREAKPOINT_KEYS = ["sm", "md", "lg", "xl"]


def _keyed_object_schema(keys: list[str], value_type: str = "string") -> dict:
    """A JSON-schema object requiring exactly these keys. Built from the
    SAME constants validate_tokens_json checks, so the tool schema and the
    validator can never drift apart. Necessary because a bare {"type":
    "object"} with no nested properties/required lets an empty {} satisfy
    the schema outright under a structured-output-strict provider — Gemini
    returned {"tokens": {}} verbatim, unprompted, on 3 consecutive attempts
    against a real brief, something Claude's forced-tool-use (which leans
    on the system prompt's prose instead) never did across many runs."""
    return {"type": "object", "properties": {key: {"type": value_type} for key in keys}, "required": list(keys)}


def validate_tokens_json(tokens: dict) -> list[str]:
    """Mechanical completeness checks; messages feed the retry prompt.
    Reference resolution is validated separately by the deriver."""
    issues: list[str] = []

    def require(path: list[str], keys: list[str]) -> None:
        node = tokens
        for segment in path:
            node = node.get(segment) if isinstance(node, dict) else None
            if node is None:
                issues.append(f"missing section {'.'.join(path)}")
                return
        for key in keys:
            if key not in node:
                issues.append(f"{'.'.join(path)} is missing key \"{key}\"")

    require(["color", "primary"], _COLOR_STEPS)
    require(["color", "neutral"], _COLOR_STEPS)
    require(["color", "semantic"], _SEMANTIC_KEYS)
    require(["typography", "fontFamily"], ["heading", "body", "mono"])
    require(["typography", "scale"], _SCALE_KEYS)
    require(["typography", "weight"], _WEIGHT_KEYS)
    require(["typography", "leading"], _LEADING_KEYS)
    require(["space"], _SPACE_KEYS)
    require(["radius"], _RADIUS_KEYS)
    require(["shadow"], _SHADOW_KEYS)
    require(["breakpoint"], _BREAKPOINT_KEYS)
    return issues


# ---------- static per-primitive specs (contract 4.1) ----------

_COMMON = (
    "nodeId?: string spread as data-node-id on the root element; "
    "className?: string merged LAST via cx(); children typed ReactNode where noted; "
    # Passthrough is a DELIBERATELY BOUNDED list, not `...rest`. Sections must be
    # able to make a primitive accessible or draggable without the primitive
    # growing a bespoke prop for every case -- but a blanket
    # ComponentPropsWithoutRef<"input"> would collide with the value-shaped
    # onChange signatures above (DOM onChange takes an event, ours takes a
    # string), which is a type error the section author cannot fix.
    "and it ALSO accepts these passthrough props, forwarded verbatim to the root "
    "element: aria-* (declared as `'aria-label'?: string` etc. or via "
    "`AriaAttributes`), role, title, tabIndex, draggable, and the handlers "
    "onClick/onDragStart/onDragOver/onDrop/onFocus/onBlur. Never widen this into "
    "a full DOM props spread"
)

PRIMITIVE_SPECS: dict[str, str] = {
    "Button": f'({{ nodeId?, variant?: "primary" | "secondary" | "ghost", href?, type?: "button" | "submit", disabled?: boolean, onClick?: () => void, className?, children }}) — renders <a> styled as a button when href is set (type/disabled/onClick apply only to the <button> case, not the <a> case), else <button> (type defaults to "button"; disabled dims and blocks pointer events via CSS, not just the native attribute). {_COMMON}',
    "Card": f'({{ nodeId?, variant?: "default" | "outlined", className?, children }}) — surface panel: padding, radius, subtle shadow (default) or border (outlined). {_COMMON}',
    "Input": f'({{ nodeId?, type?, placeholder?, defaultValue?, onChange?: (value: string) => void, className? }}) — single-line text input; onChange receives the string value. {_COMMON}',
    "Textarea": f'({{ nodeId?, placeholder?, defaultValue?, rows?, onChange?: (value: string) => void, className? }}) — multi-line input. {_COMMON}',
    "Select": f'({{ nodeId?, options: Array<{{ label: string; value: string }}>, defaultValue?, onChange?: (value: string) => void, className? }}). {_COMMON}',
    "Badge": f'({{ nodeId?, variant?: "neutral" | "accent" | "success" | "danger", className?, children }}) — small pill label. {_COMMON}',
    # Form controls (added for the app-screen archetype set). Contract 4.1's
    # list is a MINIMUM and 4.2 reserves additions to the Design System Agent;
    # these are here because a form product cannot be built without them and
    # every archetype that needs one needs the SAME one -- a checkbox
    # hand-rolled per section is exactly the inconsistency primitives exist to
    # prevent. Each is controlled-optional (checked + onChange) so a section
    # stays presentational and the container owns the state.
    "Checkbox": f'({{ nodeId?, label?: string, checked?: boolean, defaultChecked?: boolean, disabled?: boolean, onChange?: (checked: boolean) => void, className? }}) — native <input type="checkbox"> plus its <label>; label is optional so it can also be used bare in a table row. {_COMMON}',
    "Radio": f'({{ nodeId?, name: string, value: string, label?: string, checked?: boolean, defaultChecked?: boolean, disabled?: boolean, onChange?: (value: string) => void, className? }}) — native <input type="radio">; `name` groups the set, and onChange receives the VALUE, not the event. {_COMMON}',
    "Switch": f'({{ nodeId?, label?: string, checked?: boolean, defaultChecked?: boolean, disabled?: boolean, onChange?: (checked: boolean) => void, className? }}) — a toggle rendered as <button role="switch" aria-checked>, NOT a checkbox: it is for settings that apply immediately, which is what a properties inspector is made of. {_COMMON}',
    "Progress": f'({{ nodeId?, value: number, max?: number, label?: string, variant?: "bar" | "steps", className? }}) — determinate progress; "bar" is a filled track, "steps" is a discrete step tracker. Renders role="progressbar" with aria-valuenow/valuemax. {_COMMON}',
    "Heading": f'({{ nodeId?, level?: 1 | 2 | 3, variant?: "display" | "section" | "subsection", className?, children }}) — level picks h1/h2/h3; variant picks the type scale. {_COMMON}',
    "Text": f'({{ nodeId?, variant?: "body" | "lead" | "eyebrow" | "caption", className?, children }}) — renders <p>; eyebrow is small uppercase accent. {_COMMON}',
    "Link": f'({{ nodeId?, href, external?, className?, children }}) — inline text link; external adds target/rel. {_COMMON}',
    "Image": f'({{ nodeId?, src, alt, className? }}) — rounded, w-full, object-cover img. {_COMMON}',
    "Container": f"({{ nodeId?, className?, children }}) — centered max-width content wrapper with horizontal padding (max-w-(--breakpoint-xl))). {_COMMON}",
    "Grid": f'({{ nodeId?, columns?: 2 | 3 | 4, className?, children }}) — responsive grid (1 column on small screens) with token gap. {_COMMON}',
    "Stack": f'({{ nodeId?, direction?: "vertical" | "horizontal", gap?: "sm" | "md" | "lg", className?, children }}) — flex stack with token gaps. {_COMMON}',
    "Divider": f"({{ nodeId?, className? }}) — horizontal rule using the border semantic color. {_COMMON}",
    "Icon": f'({{ nodeId?, name: "check" | "arrow-right" | "star" | "chevron-down" | "plus" | "x" | "text" | "paragraph" | "circle" | "square" | "mail" | "upload" | "calendar" | "clock" | "pen" | "grip" | "paperclip" | "search" | "trash" | "copy" | "settings", size?: "sm" | "md", className? }}) — inline SVG, stroke currentColor, no fill colors. The union is CLOSED: a section may only ask for a name in this list, so every name here must render something. {_COMMON}',
    # Added in 7.4. Contract 4.1 specifies a MINIMUM set and 4.2 reserves
    # adding primitives to this agent, so this is a sanctioned extension, not
    # a contract change. It exists because a developer wiring a section to a
    # real API must render loading/error/success somewhere and had nothing to
    # render them with -- both 6.4 handover trials hand-composed status markup
    # in a page container whose docblock disclaims styling decisions.
    "Notice": f'({{ nodeId?, variant?: "info" | "error" | "success", className?, children }}) — runtime status surface (loading / error / success) for the INTEGRATION layer, not for section copy: bordered, tinted by variant via the semantic border/danger/success tokens, role="status". {_COMMON}',
}

EXPECTED_PRIMITIVE_FILES = {f"src/primitives/{name}.tsx" for name in PRIMITIVE_SPECS}


def validate_primitive_output(files: dict[str, str], inventory: list[str]) -> list[str]:
    issues: list[str] = []
    provided = set(files)
    for missing in sorted(EXPECTED_PRIMITIVE_FILES - provided):
        issues.append(
            f"missing primitive file {missing} (emit every one of the "
            f"{len(PRIMITIVE_SPECS)} primitives in the spec list, no more and no fewer)"
        )
    for stray in sorted(provided - EXPECTED_PRIMITIVE_FILES):
        issues.append(f"unexpected file {stray}: the Design System Agent writes only src/primitives/<Name>.tsx")
    if len(inventory) != len(PRIMITIVE_SPECS):
        issues.append(f"inventory must contain exactly {len(PRIMITIVE_SPECS)} signature lines, got {len(inventory)}")
    return issues


# ---------- deterministic primitive gallery (eyeball review) ----------


def build_gallery_source() -> str:
    """Dev-only gallery replacing the page while no sections exist. No node
    ids (not editor-addressable) and not a section file (gate 5 exempt)."""
    return '''import Badge from "../../primitives/Badge";
import Button from "../../primitives/Button";
import Card from "../../primitives/Card";
import Checkbox from "../../primitives/Checkbox";
import Container from "../../primitives/Container";
import Divider from "../../primitives/Divider";
import Grid from "../../primitives/Grid";
import Heading from "../../primitives/Heading";
import Icon from "../../primitives/Icon";
import Image from "../../primitives/Image";
import Notice from "../../primitives/Notice";
import Progress from "../../primitives/Progress";
import Radio from "../../primitives/Radio";
import Input from "../../primitives/Input";
import Link from "../../primitives/Link";
import Select from "../../primitives/Select";
import Stack from "../../primitives/Stack";
import Switch from "../../primitives/Switch";
import Text from "../../primitives/Text";
import Textarea from "../../primitives/Textarea";

const sampleImage =
  "data:image/svg+xml," +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="silver"/></svg>');

/** Deterministic primitive gallery — dev-only eyeball review (5.2). */
export default function HomePage() {
  return (
    <Container className="py-(--space-12)">
      <Stack direction="vertical" gap="lg">
        <section>
          <Heading level={1} variant="display">Display heading</Heading>
          <Heading level={2} variant="section">Section heading</Heading>
          <Heading level={3} variant="subsection">Subsection heading</Heading>
        </section>

        <section>
          <Text variant="eyebrow">Eyebrow text</Text>
          <Text variant="lead">Lead paragraph text for standfirsts and subheadlines.</Text>
          <Text variant="body">Body paragraph text for general copy.</Text>
          <Text variant="caption">Caption text for fine print.</Text>
          <Text variant="body">
            Inline <Link href="/">internal link</Link> and{" "}
            <Link href="https://example.com" external>external link</Link>.
          </Text>
        </section>

        <Stack direction="horizontal" gap="md">
          <Button variant="primary">Primary action</Button>
          <Button variant="secondary">Secondary action</Button>
          <Button variant="ghost">Ghost action</Button>
          <Button variant="primary" href="/">Link button</Button>
        </Stack>
        <Stack direction="vertical" gap="sm">
          <Notice variant="info">Loading…</Notice>
          <Notice variant="error">Something went wrong.</Notice>
          <Notice variant="success">Saved.</Notice>
        </Stack>

        <Stack direction="vertical" gap="sm">
          <Checkbox label="Checkbox, unchecked" />
          <Checkbox label="Checkbox, checked" defaultChecked />
          <Checkbox label="Checkbox, disabled" disabled />
          <Radio name="gallery-choice" value="a" label="Radio A" defaultChecked />
          <Radio name="gallery-choice" value="b" label="Radio B" />
          <Switch label="Switch, off" />
          <Switch label="Switch, on" defaultChecked />
        </Stack>

        <Stack direction="vertical" gap="sm">
          <Progress value={40} label="Bar progress" variant="bar" />
          <Progress value={2} max={4} label="Step progress" variant="steps" />
        </Stack>

        <Stack direction="horizontal" gap="sm">
          <Badge variant="neutral">Neutral</Badge>
          <Badge variant="accent">Accent</Badge>
          <Badge variant="success">Success</Badge>
          <Badge variant="danger">Danger</Badge>
        </Stack>

        <Grid columns={3}>
          <Card variant="default">
            <Heading level={3} variant="subsection">Default card</Heading>
            <Text variant="body">Card body copy.</Text>
          </Card>
          <Card variant="outlined">
            <Heading level={3} variant="subsection">Outlined card</Heading>
            <Text variant="body">Card body copy.</Text>
          </Card>
          <Card variant="default">
            <Image src={sampleImage} alt="Sample" />
          </Card>
        </Grid>

        <Divider />

        <Grid columns={2}>
          <Stack direction="vertical" gap="sm">
            <Input placeholder="Your email" />
            <Textarea placeholder="Your message" rows={3} />
            <Select
              options={[
                { label: "Starter", value: "starter" },
                { label: "Growth", value: "growth" },
              ]}
            />
          </Stack>
          <Stack direction="horizontal" gap="md">
            <Icon name="check" />
            <Icon name="arrow-right" />
            <Icon name="star" />
            <Icon name="chevron-down" />
            <Icon name="plus" size="sm" />
            <Icon name="x" size="sm" />
          </Stack>
        </Grid>
      </Stack>
    </Container>
  );
}
'''


# ---------- prompts ----------

TOKENS_SYSTEM = (
    "You are the Design System Agent of an automated website generator. From "
    "the normalized brand brief, emit tokens.json — the single source of truth "
    "every page of the site styles against (codegen contract 3.1).\n\n"
    "Required shape (all keys mandatory):\n"
    '- version: 1; meta: { themeName, generatedAt ISO-8601 }\n'
    f"- color.primary and color.neutral: full scales with steps {', '.join(_COLOR_STEPS)} (hex values; neutral stays near-gray)\n"
    f"- color.semantic: {', '.join(_SEMANTIC_KEYS)} — use \"ref:color.primary.600\"-style references into the scales where sensible; accentContrast/danger/success may be direct hex\n"
    f"- typography.fontFamily: heading, body, mono — real, widely-available web-safe/system font stacks that fit the brand\n"
    f"- typography.scale: {', '.join(_SCALE_KEYS)} (rem values); weight: {', '.join(_WEIGHT_KEYS)} (numbers); leading: {', '.join(_LEADING_KEYS)} (unitless)\n"
    f"- space: keys {', '.join(_SPACE_KEYS)} (rem values, 0.25rem grid); radius: {', '.join(_RADIUS_KEYS)}; shadow: {', '.join(_SHADOW_KEYS)} (CSS shadow values); breakpoint: sm 640px, md 768px, lg 1024px, xl 1280px\n\n"
    "Make the system DISTINCTIVE for the brand: hue, contrast posture, radius "
    "personality (sharp vs soft), and shadow weight should all follow the "
    "brand tone — two different brands must not receive the same palette."
)

PRIMITIVES_SYSTEM_TEMPLATE = (
    "You are the Design System Agent of an automated website generator, now "
    "generating the fixed v1 primitive set — the only components page agents "
    "may compose (codegen contract 4.1). This is constrained fill-in: the "
    "props shapes below are FIXED; your creative input is the styling.\n\n"
    "Rules (machine-checked):\n"
    "- Emit EXACTLY these 15 files: src/primitives/<Name>.tsx, one component per file.\n"
    "- Each file: a typed functional component, default export, with an exported props interface named <Name>Props.\n"
    '- import {{ cx }} from "../lib/cx"; import type {{ NodeProps }} from "../lib/types"; props interfaces extend NodeProps.\n'
    "- nodeId is spread as data-node-id on the root element; className is merged LAST via cx().\n"
    "- Style ONLY with Tailwind utilities over the token CSS variables listed below. NEVER raw hex, NEVER raw px, no new files, no other imports.\n"
    "- Variants are closed unions exactly as specified; style every variant distinctly.\n\n"
    "PRIMITIVE SPECS (fixed):\n{specs}\n\n"
    "Also emit inventory: one compact signature line per primitive (the exact "
    "props shape, for page-agent context).\n\n"
    "Design intent: primitives carry the brand — button personality, card "
    "depth, input chrome. Follow the brief's tone through the tokens."
)

TOKENS_TOOL = {
    "type": "object",
    "properties": {
        "tokens": {
            "type": "object",
            "description": "tokens.json content per contract 3.1",
            "properties": {
                "color": {
                    "type": "object",
                    "properties": {
                        "primary": _keyed_object_schema(_COLOR_STEPS),
                        "neutral": _keyed_object_schema(_COLOR_STEPS),
                        "semantic": _keyed_object_schema(_SEMANTIC_KEYS),
                    },
                    "required": ["primary", "neutral", "semantic"],
                },
                "typography": {
                    "type": "object",
                    "properties": {
                        "fontFamily": _keyed_object_schema(["heading", "body", "mono"]),
                        "scale": _keyed_object_schema(_SCALE_KEYS),
                        "weight": _keyed_object_schema(_WEIGHT_KEYS, "number"),
                        "leading": _keyed_object_schema(_LEADING_KEYS, "number"),
                    },
                    "required": ["fontFamily", "scale", "weight", "leading"],
                },
                "space": _keyed_object_schema(_SPACE_KEYS),
                "radius": _keyed_object_schema(_RADIUS_KEYS),
                "shadow": _keyed_object_schema(_SHADOW_KEYS),
                "breakpoint": _keyed_object_schema(_BREAKPOINT_KEYS),
            },
            "required": ["color", "typography", "space", "radius", "shadow", "breakpoint"],
        }
    },
    "required": ["tokens"],
}

PRIMITIVES_TOOL = {
    "type": "object",
    "properties": {
        "files": {
            "type": "object",
            "description": f"src/primitives/<Name>.tsx -> complete file content, exactly {len(PRIMITIVE_SPECS)} entries",
            "properties": {f"src/primitives/{name}.tsx": {"type": "string"} for name in PRIMITIVE_SPECS},
            "required": [f"src/primitives/{name}.tsx" for name in PRIMITIVE_SPECS],
        },
        "inventory": {
            "type": "array",
            "items": {"type": "string"},
            "minItems": len(PRIMITIVE_SPECS),
            "maxItems": len(PRIMITIVE_SPECS),
        },
    },
    "required": ["files", "inventory"],
}


# ---------- checkpointed steps ----------


@checkpoint
def generate_tokens(run_id: str, brief_json: str, attempt: int, failure_report: str) -> dict:
    user = f"Brand brief:\n{brief_json}"
    if failure_report:
        user += f"\n\nPREVIOUS TOKENS FAILED VALIDATION. Fix every issue:\n{failure_report}"
    result = call_model_structured_impl(
        role="design-system",
        system=TOKENS_SYSTEM,
        user=user,
        tool_name="emit_tokens",
        tool_description="Emit tokens.json for the brand.",
        tool_schema=TOKENS_TOOL,
        max_tokens=6000,
    )
    append_run_event(
        default_run_log_path(run_id),
        run_id=run_id,
        event_type="tokens.complete",
        attempt=attempt,
        model=result["model"],
        usage=result["usage"],
        duration_s=result.get("duration_s"),
        raw_output=json.dumps(result["data"], indent=2),
        checkpoint_ref=f"{kitaru.current_execution_id()}/generate_tokens#a{attempt}",
    )
    return result["data"]


@checkpoint
def write_tokens(project_dir: str, tokens_result: dict, attempt: int) -> dict:
    """Writes tokens.json and runs the deterministic deriver (M1) — the
    deriver's ref/cycle errors become retry-report issues."""
    tokens_path = Path(project_dir) / "src" / "tokens" / "tokens.json"
    tokens_path.write_text(
        json.dumps(tokens_result["tokens"], indent=2) + "\n", encoding="utf-8"
    )
    result = _run_compiler_cli(["scripts/derive-fixture-tokens.ts", project_dir])
    return {"ok": result.returncode == 0, "error": result.stderr.strip() or result.stdout.strip()}


@checkpoint
def generate_primitives(
    run_id: str, brief_json: str, token_summary: str, attempt: int, failure_report: str
) -> dict:
    specs = "\n".join(f"- {name}{spec}" for name, spec in PRIMITIVE_SPECS.items())
    user = f"Brand brief:\n{brief_json}\n\nTOKENS (style only through these):\n{token_summary}"
    if failure_report:
        user += f"\n\nPREVIOUS ATTEMPT FAILED VALIDATION. Fix every issue:\n{failure_report}"
    result = call_model_structured_impl(
        role="design-system",
        system=PRIMITIVES_SYSTEM_TEMPLATE.format(specs=specs, primitive_count=len(PRIMITIVE_SPECS)),
        user=user,
        tool_name="emit_primitives",
        tool_description="Emit the 15 primitive files and their inventory signatures.",
        tool_schema=PRIMITIVES_TOOL,
        max_tokens=24000,
    )
    append_run_event(
        default_run_log_path(run_id),
        run_id=run_id,
        event_type="primitives.complete",
        attempt=attempt,
        model=result["model"],
        usage=result["usage"],
        duration_s=result.get("duration_s"),
        raw_output=json.dumps(result["data"], indent=2)[:20000],
        checkpoint_ref=f"{kitaru.current_execution_id()}/generate_primitives#a{attempt}",
    )
    return result["data"]


@checkpoint
def write_primitives(project_dir: str, primitives_result: dict, attempt: int) -> dict:
    """Full-replaces src/primitives/, writes the inventory + gallery page,
    then validates: tsc --noEmit + gates. Returns the failure report."""
    project = Path(project_dir)
    primitives_dir = project / "src" / "primitives"
    if primitives_dir.exists():
        shutil.rmtree(primitives_dir)
    primitives_dir.mkdir(parents=True)
    for rel_path, content in primitives_result["files"].items():
        (project / rel_path).write_text(content, encoding="utf-8", newline="\n")

    (project / "design-inventory.json").write_text(
        json.dumps({"primitives": primitives_result["inventory"]}, indent=2) + "\n",
        encoding="utf-8",
    )
    home = project / "src" / "pages" / "home"
    home.mkdir(parents=True, exist_ok=True)
    (home / "index.tsx").write_text(build_gallery_source(), encoding="utf-8", newline="\n")

    ensure_node_modules(project)
    tsc = subprocess.run(
        ["cmd", "/c", "npx", "tsc", "--noEmit"],
        cwd=project, capture_output=True, text=True, encoding="utf-8", timeout=300,
    )
    issues: list[str] = []
    if tsc.returncode != 0:
        issues.extend(f"typecheck: {line}" for line in tsc.stdout.splitlines() if line.strip())

    gates = _run_compiler_cli(["scripts/gates.ts", str(project), "--json"])
    gate_report = json.loads(gates.stdout)
    issues.extend(
        f"gate {gate['gate']} ({gate['name']}): {failure['message']}"
        for gate in gate_report["gates"]
        for failure in gate["failures"]
    )
    return {"ok": not issues, "issues": issues[:20]}


def ensure_node_modules(project_dir: Path) -> None:
    from orchestrator.fixture_context import FIXTURE_DIR

    target = project_dir / "node_modules"
    if not target.exists():
        subprocess.run(
            ["cmd", "/c", "mklink", "/J", str(target), str(FIXTURE_DIR / "node_modules")],
            check=True, capture_output=True,
        )


# ---------- the flow ----------


@flow
def design_system_flow(run_id: str, brief_json: str, workspace_token: str = "") -> dict:
    print(f"exec_id: {kitaru.current_execution_id()}", flush=True)
    project_dir = materialize(prepare_workspace(run_id, workspace_token))

    failure_report = ""
    tokens_ok = False
    for attempt in range(1, MAX_ATTEMPTS + 1):
        tokens_result = materialize(generate_tokens(run_id, brief_json, attempt, failure_report))
        issues = validate_tokens_json(tokens_result.get("tokens", {}))
        if not issues:
            derive = materialize(write_tokens(project_dir, tokens_result, attempt))
            if derive["ok"]:
                tokens_ok = True
                break
            issues = [f"token derivation failed: {derive['error']}"]
        failure_report = "\n".join(f"- {issue}" for issue in issues)
    if not tokens_ok:
        return {"passed": False, "stage": "tokens", "failureReport": failure_report}

    tokens = json.loads(
        (Path(project_dir) / "src" / "tokens" / "tokens.json").read_text(encoding="utf-8")
    )
    token_summary = build_design_context(tokens, [])

    failure_report = ""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        primitives_result = materialize(
            generate_primitives(run_id, brief_json, token_summary, attempt, failure_report)
        )
        issues = validate_primitive_output(
            primitives_result.get("files", {}), primitives_result.get("inventory", [])
        )
        if not issues:
            written = materialize(write_primitives(project_dir, primitives_result, attempt))
            if written["ok"]:
                return {"passed": True, "project_dir": project_dir, "attempts": attempt}
            issues = written["issues"]
        failure_report = "\n".join(f"- {issue}" for issue in issues)

    return {"passed": False, "stage": "primitives", "failureReport": failure_report}
