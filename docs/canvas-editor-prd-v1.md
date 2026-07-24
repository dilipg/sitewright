# Canvas Editor PRD v1

Status: Draft for review
Depends on: `codegen-contract-v1.md` (node IDs, override schema, export), `agent-pipeline-spec-v1.md` (regeneration path).
Scope: the editing surface between generation and export. This is a product spec with the technical architecture needed to build it; visual design of the editor itself is out of scope here.

---

## 1. Product framing

### 1.1 User and job

Primary user for v1: a founder, designer, or PM who wants a website's frontend without writing code, and whose success condition is handing a developer (or a deploy pipeline, later) code that matches exactly what they see and approved.

The job of the editor is not "design freely." It is: review what the agents built, adjust content and presentation within the design system, regenerate what's wrong, and export with confidence that preview equals handover. Constrained editing is the feature, not a limitation: every edit the UI allows is one the exporter can compile faithfully.

### 1.2 What v1 is not

Not a Figma competitor (no freeform drawing, no arbitrary element insertion), no responsive per-breakpoint editing (desktop edits only; generation handles responsiveness), no collaboration, no version branches beyond undo/redo, no direct code editing in the UI (the export is the handover; developers edit in their own tools).

### 1.3 Success metrics

- ≥ 70% of generated sites receive at least one canvas edit before export (editor is load-bearing, not decorative).
- ≥ 90% of edit gestures complete without token-escape (design-system snapping is good enough that users rarely need free values).
- Zero preview/export divergence reports (the one unforgivable bug class).
- Median section regeneration round-trip under 90 seconds.

---

## 2. Surface architecture

### 2.1 Viewport

An infinite pan/zoom canvas (DOM-based, CSS-transformed stage) hosting one frame per route, laid out side by side like Figma pages. Each frame is an `<iframe>` running the live preview build (Vite dev server serving the generated project). The canvas chrome (selection handles, labels, guides) renders in an overlay layer in the parent document, never inside the iframe.

Frames render at desktop width (1280px) in v1. A read-only viewport toggle (mobile/tablet preview) is P1 and does not enable editing at those widths.

### 2.2 The bridge shim

A small script injected into the preview build (dev-mode only, stripped at export) that:

1. Indexes every `[data-node-id]` element and reports geometry: on load, on resize, on DOM mutation (`ResizeObserver` + `MutationObserver`), via `postMessage` to the parent.
2. Applies overrides live: receives the override list from the parent, applies `text` via content substitution, `style`/`layout` via a generated `<style>` sheet keyed on `[data-node-id]` selectors, `visibility` via `display: none`.
3. Forwards click/hover targets (nearest `[data-node-id]` ancestor) to the parent for selection, and suppresses the page's own interactive behavior while in edit mode (links don't navigate, forms don't submit). A separate "interact" mode lets the user try the page's real behavior with editing disabled.

Bridge protocol messages: `nodes:geometry`, `node:hit`, `overrides:apply`, `mode:set`, `frame:ready`. Keep the protocol versioned; the shim ships inside generated previews and will skew against the editor otherwise.

### 2.3 Selection model

Click selects the deepest node under the cursor; Esc or breadcrumb click walks up the ancestry (element → section → page). The manifest's `editable` channels for the selected node determine which controls appear. Elements without node IDs are not selectable, by design; if users consistently try to select something unaddressable, that's a codegen-contract gap to fix in generation, not an editor workaround.

Hover shows a subtle outline + node label (human-readable name derived from the ID: "Hero → Primary CTA"). Section boundaries show on hover at low zoom so the regeneration target is always discoverable.

---

## 3. Editing capabilities (v1)

All edits write override entries (contract 6.1), never source. Every edit is undoable (single undo stack across all channels, per project, survives reload via persisted store).

### 3.1 Text channel (P0)

Double-click any text node → inline contentEditable editing in place, styled exactly as rendered. Enter/blur commits, Esc cancels. Multi-line allowed where the underlying element is multi-line. No rich-text formatting in v1 (bold/links inside a text node are P2; they complicate export compilation disproportionately).

### 3.2 Style channel (P0)

A right-side inspector panel scoped to the selected node's `editable` channels:

- Color: pickers populated exclusively from semantic tokens (swatch grid, labeled). No free color wheel in v1.
- Typography: size/weight/leading as token-scale steppers.
- Spacing: padding/margin steppers snapped to the space scale, with a visual spacing overlay on the selected node.
- Variant: if the node is a primitive with variants, a variant switcher (this compiles to a prop change at export; it is a `style` override with key `variant`).

Free-value escape: a small "custom" affordance per control, deliberately one click deeper, which accepts raw values and marks the override as off-scale in the UI (visible badge). This preserves the token-snapping metric (1.3) while never hard-blocking the user.

### 3.3 Layout channel (P0)

Drag to reposition within the parent's flow constraints and resize via handles. Gestures snap to the space scale; holding a modifier disables snapping (creates off-scale values, badged as above). v1 layout edits are deltas the exporter can express as margin/size/alignment classes: no reparenting, no reordering across containers. Reordering sections within a page is P1 and is expressed as an index.tsx-level override (`sectionOrder` array in the route's override file), not a DOM operation.

### 3.4 Visibility channel (P0)

Hide any selectable node (eye toggle in inspector and context menu). Hidden nodes render ghosted in edit mode, removed in interact mode and at export.

### 3.5 Image handling (P1)

Replace an `Image` primitive's source: upload or URL, stored as an asset in the project, override channel `text` with key `src` (content, not style). No cropping/filters in v1.

---

## 4. Regeneration UX (the differentiating loop)

Select a section (or click its label) → "Regenerate" opens a prompt box pre-filled with the section's original planner brief. User edits the instruction ("make this 3 tiers, emphasize the middle one") → run.

Flow requirements:

1. The section frame area shows an in-place progress state; the rest of the page stays live and editable. Cost estimate (from pipeline budget: ~1 section ≈ 30k tokens) shown before confirming.
2. On success, the new section renders with surviving overrides already applied (contract 5.3 guarantees ID survival for conceptually-persistent elements).
3. If the regen orphaned any overrides, a non-blocking dialog lists them ("Your headline text edit no longer has a target") with per-item options: discard, or copy value to clipboard. No automatic reattachment in v1; wrong reattachment is worse than asking.
4. Before/after: the previous section state is kept as a one-step "revert regeneration" (this reverts code via the checkpoint fork, distinct from the override undo stack; the UI presents both as one coherent history line).
5. Two failed regens surface the failure report in plain language with a "try different instruction" affordance (pipeline 5.4).

Page-level regeneration ("redo this whole page") is P1 and reuses the same flow at page granularity. Whole-site regeneration is deliberately absent from the editor; that's a new project.

### 4.1 Add-a-section (P1)

"+" between sections opens the archetype catalog (with previews) + an instruction box. Runs as a regen-style single-section generation appended to the site plan. This, not freeform drawing, is how users add content in this product.

---

## 5. Export flow

Export button → deterministic compilation pipeline (contract 7) → progress with explicit gate steps (compile overrides, typecheck, lint, build) → result:

- Success: downloadable zip + file tree preview + a generated `HANDOVER.md` summarizing the props/mock-data seam, the integration TODO list (every no-op handler), and off-scale overrides a developer may want to normalize.
- Failure: loud, with the failing gate's report. Never a silent partial export.

The pre-export state remains fully editable; export is repeatable and idempotent.

---

## 6. Persistence and state

- Overrides: per-route JSON files (contract 6.1), autosaved on every commit, debounced.
- Undo/redo: operation log persisted with the project; regeneration checkpoints referenced by ID in the same history stream.
- Editor state (zoom, pan, selection): localStorage-class persistence, non-critical. Note: web-app localStorage, not required for correctness.
- Project state (generated code + manifest + overrides + run log) is the atomic unit; "open project" restores canvas exactly.

---

## 7. Priorities and acceptance criteria

| Priority | Capability | Acceptance criterion |
|---|---|---|
| P0 | Viewport + frames + bridge | All routes render live; selection works on every manifest node; 60fps pan/zoom on a 6-page site |
| P0 | Text, style, layout, visibility edits | Each edit visible in < 100ms; produces a valid override entry; undoable |
| P0 | Override persistence | Reload restores all edits exactly |
| P0 | Section regeneration | Round-trip works end to end incl. orphan dialog; surviving overrides re-apply without user action |
| P0 | Export | Preview-vs-export pixel divergence: none for edited nodes across the test suite |
| P1 | Section reorder, add-a-section, image replace, responsive read-only preview | per above |
| P2 | Rich text inline formatting, multi-select, edit-history browser | later |

### 7.1 The invariant test (build this first)

An automated suite that, for each edit channel: applies an override in the editor, exports, builds the export, and screenshot-diffs the exported page against the edited preview. This suite is the contract's enforcement mechanism and the guard against the product's only unforgivable failure (preview ≠ handover). It runs in CI on every change to the shim, the exporter, or the primitive set.

---

## 8. Technical risks specific to the editor

1. **Geometry staleness**: overrides changing layout invalidate cached geometry; the shim must re-report after every `overrides:apply`, and the overlay must not flicker. Mitigation: batch geometry updates per animation frame.
2. **Iframe count**: 6+ live Vite-served frames is heavy. Mitigation: virtualize; only frames in/near viewport run live, others show a cached screenshot until scrolled to.
3. **Layout-channel expressiveness**: drag gestures users expect (pull an element into a different column) exceed v1's no-reparenting rule. Mitigation: constrain the gesture visually (drag ghosts snap back with a hint toast: "Regenerate the section to change its structure"), and log every rejected gesture as roadmap signal.
4. **Shim/editor version skew**: protocol versioning + editor refuses to attach to an older shim, prompting a preview rebuild.
