"""G5: a generated site must never reference an image that cannot load.

The dogfood run shipped every image pointed at `images.yourbrand.example`, and
round 1 before it reported "ten broken `.example` images from two different
invented hostnames". `.example` is reserved by IANA (RFC 2606) precisely so that
it can NEVER resolve — not on a slow network, not behind a proxy, not ever. So a
tester's first view of their own generated site is broken images throughout, and
so is the handover export a developer opens later.

WHY A DATA URI, and not the alternatives:

- A real placeholder service (placehold.co, picsum.photos) resolves and looks
  good, but it puts a THIRD-PARTY NETWORK DEPENDENCY inside the deliverable. The
  product's promise is developer-handover-quality code and the export zip is the
  artefact; a developer building on a plane, behind a corporate proxy, or in a
  sealed CI container gets exactly the defect we are fixing. It would also make
  the invariant suite's preview-vs-export screenshot diff — a required CI check —
  depend on a remote host's uptime and on its image bytes never changing.
- Local placeholder files committed under `public/` always work offline, but the
  reference has to be a URL, and the site is served from more than one base: `/`
  locally and `/preview/<projectId>/` through the hosted proxy. A root-absolute
  `/placeholder.svg` 404s under the proxy, which is the one surface a tester
  actually looks at. Making it an `import` instead drags in a `*.svg` module
  declaration for gate 1's `tsc --noEmit`, and a filename typo becomes a broken
  image again that no gate can see, because a `public/` reference resolves at
  runtime, not at build time.
- Omitting images and reserving the space is honest but shows the tester a
  half-designed page, and gives the developer no `src` to swap.

An inline SVG data URI has none of those failure modes: no host, no base path,
no import, no module declaration, no file that can go missing. It renders
identically at `/`, under `/preview/<id>/`, in `vite build`, in the export zip,
and offline — which also makes it deterministic for the screenshot diff.

TWO ENCODING DETAILS ARE LOAD-BEARING, not cosmetic:

- The `#` of the fill colour is written `%23`. A literal `#e4e7ec` in a mock data
  file is matched by compiler gate 3's RAW_HEX (`/#(?:[0-9a-fA-F]{6}|...)\b/`),
  which scans every file in scope except `src/tokens/` — so the unencoded form
  would fail a gate on EVERY section that has an image, on every retry.
- The SVG uses single quotes throughout, so the whole URI drops into a
  double-quoted TypeScript string with no escaping.

The `viewBox` with no width/height is what makes it scale: with intrinsic pixel
dimensions instead, the rect would not stretch to the box the `Image` primitive
gives it.

WHY THE URI IS WRITTEN OUT AT EVERY IMAGE FIELD, and never hoisted into one
module-level const per file (which is what the first version of this rule taught,
and what the whole-branch review caught before it ever reached a live run):

`docs/codegen-contract-v1.md` section 7.1 defines the TEXT channel as locating
"the prop value or mock data field feeding the node ... and rewriting the mock
data LITERAL". `compiler/src/exporter.ts` implements exactly that, in two places
(`applyTextOverride`, `applyListItemTextOverride`), and both resolve the leaf via
`.asKind(SyntaxKind.StringLiteral)` and throw `ExportError` otherwise:

    Mock field "<field>" for node "<id>" is not a string literal;
    text overrides rewrite string literals only.

A hoisted const makes the field an `Identifier`, not a `StringLiteral`. Image
replace (PRD 3.5, feature 7.7) IS the text channel with key `src`, so a shared
const turns a single image edit into a PERMANENT export failure for the whole
project — the preview looks right, the export dies naming a mock field the user
has never seen, and the error carries no gate report, so the editor classifies it
as retryable and offers a button that can never work. The only escape is
discarding the edit.

Teaching the exporter to resolve identifiers was rejected: the contract wins all
conflicts in this repo, and the deterministic spine is what guarantees preview =
handover, so it does not grow a special case to accommodate a prompt's choice.
One const also feeds many items, so rewriting through it would silently change
every other image that shares it. Verbose mock data is disposable output; a
broken export is not.
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

#: The const name the first version of digest rule 9 taught, kept because rule 9
#: now names it as the ANTI-PATTERN it forbids — see the module docstring for why
#: a hoisted const breaks the text channel. Nothing generates this name any more;
#: the tests use it to pin that the rule forbids rather than prescribes it.
HOISTED_CONST_NAME = "PLACEHOLDER_IMAGE"

#: A flat neutral 4:3 swatch. Deliberately plain — the same shape
#: `design_pipeline.build_gallery_source` has always used for its sample image —
#: because every extra glyph is bytes duplicated into every mock data file of
#: every generated site, and because a plain swatch already reads as "not a
#: photograph" without pretending to be art.
PLACEHOLDER_IMAGE_DATA_URI = (
    "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'"
    "%20viewBox='0%200%204%203'%3E%3Crect%20width='4'%20height='3'"
    "%20fill='%23e4e7ec'/%3E%3C/svg%3E"
)

#: The one comment line that ships at the top of a generated mock data file. It
#: is the whole handover story for images in one line — and it is a COMMENT, so
#: it is invisible to the exporter's AST rewrite either way.
PLACEHOLDER_COMMENT = (
    "// Placeholder artwork: an inline SVG data URI, so it renders offline and "
    "inside the export zip. Swap in your real image URLs."
)

# RFC 2606 / RFC 6761 reserved names. Every one of these is guaranteed never to
# serve real content — that guarantee is the point, and it is what makes this
# check a fact about the string rather than a judgement about the brief.
_RESERVED_TLDS = ("example", "invalid", "test", "localhost")
_RESERVED_DOMAINS = ("example.com", "example.net", "example.org")

_IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".svg", ".ico", ".bmp")

# Any file extension at all, image or not. A NON-image extension is a positive
# signal to leave the value alone: `detail-drawer` legitimately points a
# `mediaSrc` at `files.yourbrand.example/....pdf` — an uploaded document, not a
# picture — and swapping a PDF attachment for a grey swatch would be a new bug.
_FILE_SUFFIX = re.compile(r"\.[A-Za-z0-9]{2,5}$")

# A quoted http(s) literal, optionally preceded by the key it is assigned to
# (`photoSrc: "..."` in mock data, `src="..."` in TSX, or a bare literal).
_QUOTED_URL = re.compile(
    r"""(?:(?P<key>[A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*)?"""
    r"""(?P<quote>["'])(?P<url>https?://[^"'\s]+)(?P=quote)"""
)

_IMAGE_KEY = re.compile(
    r"image|img|photo|avatar|logo|thumb|poster|banner|artwork|screenshot|src|icon",
    re.IGNORECASE,
)

# Keys whose value is a LINK, not an image. `docs-toc-page` deliberately points
# its doc entries at an external placeholder URL under a reserved domain, and a
# dead link is not this fix's business — rewriting an href into a data URI would
# be nonsense. Checked AFTER _IMAGE_KEY so `imageUrl` stays an image.
_LINK_KEY = re.compile(r"^(?:href|url|link|to|path|route)$", re.IGNORECASE)


def is_unresolvable_host(host: str) -> bool:
    """True when the host is reserved and therefore can never resolve."""
    host = host.lower().rstrip(".").split(":")[0]
    if not host:
        return False
    if host.split(".")[-1] in _RESERVED_TLDS:
        return True
    return any(host == domain or host.endswith(f".{domain}") for domain in _RESERVED_DOMAINS)


def is_unloadable_image_url(url: str, key: str | None = None) -> bool:
    """True when `url` is an image reference that can never load.

    Requires BOTH a reserved host and evidence that the value is an image: a
    real host the brief supplied is left alone, and so is a link, and so is a
    non-image file. The extension decides whenever there is one, because it is
    a fact about the value; the key is consulted only for an extensionless URL,
    where nothing else can tell an image endpoint from a page.
    """
    parts = urlsplit(url)
    if not is_unresolvable_host(parts.hostname or ""):
        return False

    # A key named exactly `href`/`url`/`to` is a link whatever it points at.
    # Anchored, so `imageUrl` is still an image.
    if key and _LINK_KEY.match(key):
        return False

    path = parts.path.lower()
    if path.endswith(_IMAGE_SUFFIXES):
        return True
    if _FILE_SUFFIX.search(path):
        return False  # a .pdf / .zip / .mp4 is not a broken image
    return bool(key and _IMAGE_KEY.search(key))


def find_unloadable_image_urls(source: str) -> list[str]:
    """Every unloadable image URL in a file's text, in order of appearance."""
    found = []
    for match in _QUOTED_URL.finditer(source):
        if is_unloadable_image_url(match.group("url"), match.group("key")):
            found.append(match.group("url"))
    return found


def repair_image_sources(source: str) -> tuple[str, list[str]]:
    """Replaces every unloadable image URL with the placeholder data URI.

    Returns (repaired source, the URLs replaced). This REPAIRS rather than
    fails, unlike the brand-name backstop that refuses `<UNKNOWN>` at intake:
    there, only a human knows the right value, so refusing at the $0.003 call
    is the cheap move. Here the correct value is a fixed constant, so a
    deterministic rewrite costs nothing, never burns a retry, and never turns a
    cosmetic defect into a lost section (a section that exhausts its retries
    ships as a FailedSectionPlaceholder — strictly worse for the tester than a
    grey swatch). Idempotent: the placeholder is a data URI and matches nothing.
    """
    replaced: list[str] = []

    def substitute(match: re.Match[str]) -> str:
        url = match.group("url")
        if not is_unloadable_image_url(url, match.group("key")):
            return match.group(0)
        replaced.append(url)
        return match.group(0).replace(url, PLACEHOLDER_IMAGE_DATA_URI)

    return _QUOTED_URL.sub(substitute, source), replaced


# --------------------------------------------------------------------------
# the second backstop: a hoisted string const, inlined back to a literal
# --------------------------------------------------------------------------

# A module-level `const NAME = "value";` — anchored at column 0, so a const
# declared INSIDE a function or an object is never touched, and not `export`ed,
# so removing the declaration can never break another file's import (a page
# agent's section file imports `<sectionName>Data` from its mock file and could
# in principle import a named const too).
_MODULE_CONST = re.compile(
    r'^const (?P<name>[A-Za-z_$][A-Za-z0-9_$]*) = "(?P<value>[^"\\\n]*)";[ \t]*\n',
    re.MULTILINE,
)

# One TypeScript "atom" at a time: a comment, a string/template literal, or a
# bare word. Consuming comments and strings in the SAME alternation is what makes
# the identifier substitution below safe — an occurrence of the const's name
# inside a comment or inside another string is matched as that comment or string
# and passed through untouched, never rewritten.
_TS_ATOM = re.compile(
    r"""(?P<skip>//[^\n]*|/\*.*?\*/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)"""
    r"""|(?P<word>[A-Za-z_$][A-Za-z0-9_$]*)""",
    re.VERBOSE | re.DOTALL,
)


def inline_hoisted_string_consts(source: str) -> tuple[str, list[str]]:
    """Rewrites `const X = "lit"; ... field: X` into `field: "lit"`.

    THE SECOND HALF OF THE C1 FIX, and the half that does not depend on a model
    obeying prose. Digest rule 9 now tells the page agent to write the data URI
    out at every image field and explicitly forbids hoisting it into a shared
    const; this makes the forbidden shape impossible to ship even when the model
    hoists anyway — which is the likely failure, because sharing a long repeated
    literal is what a competent programmer does everywhere else.

    Contract 7.1's text channel rewrites the mock data LITERAL feeding a node, so
    a mock field bound to an identifier cannot be compiled by the exporter at all
    — and that is true of EVERY hoisted string, not only an image URI (a shared
    `const CTA_LABEL = "Get started"` breaks a copy edit on those nodes in
    exactly the same way). So this inlines any hoisted string const rather than
    special-casing the placeholder: the general rule is simpler than the special
    case and closes the whole defect class.

    Deliberately narrow, in four ways, because this rewrites model-authored
    TypeScript with a regex rather than an AST (there is no TS parser in the
    Python side of this repo, and adding one for this is not proportionate):

    - Only `const NAME = "double-quoted, escape-free";` at column 0 — module
      scope, one line, unambiguous value.
    - Only NON-exported consts, so removing the declaration cannot break an
      import in the section file beside it.
    - Identifier occurrences inside strings and comments are skipped by
      construction (`_TS_ATOM` consumes them first).
    - The declaration is removed only when it was inlined, and inlining a string
      literal for a `const` binding is semantics-preserving by definition.

    A reference inside a template literal (`${NAME}`) is NOT inlined — it is
    consumed as part of the backtick atom. That leaves such a field exactly as
    unexportable as it is today, i.e. no worse, and mock data does not use
    template literals; widening the regex to reach inside `${...}` would risk
    far more than it buys. By the same trade, a line that merely LOOKS like a
    module const because it sits at column 0 inside a multi-line template literal
    would be misread — accepted, because a `.data.ts` mock file containing
    TypeScript source inside a template literal is not a shape this pipeline
    produces, and the alternative is a TypeScript parser in the Python package.

    A const nothing references is left exactly where the model put it: this
    exists to make a REFERENCE compilable, not to tidy anyone's code.

    Returns (rewritten source, the names inlined).
    """
    declarations = {match.group("name"): match for match in _MODULE_CONST.finditer(source)}
    if not declarations:
        return source, []

    inlined: set[str] = set()

    def substitute(match: re.Match[str]) -> str:
        word = match.group("word")
        if word is None or word not in declarations:
            return match.group(0)
        # the declaration's own `NAME` is not a reference to itself
        declaration = declarations[word]
        if declaration.start() <= match.start() < declaration.end():
            return match.group(0)
        inlined.add(word)
        return f'"{declaration.group("value")}"'

    body = _TS_ATOM.sub(substitute, source)
    if not inlined:
        return source, []

    for name in sorted(inlined):
        line = f'const {name} = "{declarations[name].group("value")}";'
        body = re.sub(rf"^{re.escape(line)}[ \t]*\n", "", body, count=1, flags=re.MULTILINE)
    return body, sorted(inlined)
