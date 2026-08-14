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
"""

from __future__ import annotations

import re
from urllib.parse import urlsplit

#: The name page agents are told to bind the URI to in a mock data file. One
#: module-level const per file, referenced by every image, rather than a shared
#: module: no page agent may write outside its own page directory (contract
#: section 2), and per-file duplication is what lets a developer delete it one
#: file at a time as they wire real images.
PLACEHOLDER_CONST_NAME = "PLACEHOLDER_IMAGE"

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

#: The comment that ships beside the const in generated mock data. It is the
#: whole handover story for images in one line.
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
