/**
 * The invariant-suite case table (PRD 7.1). Milestone 5 extends coverage to
 * all channels and archetypes BY ADDING CASES HERE, not code: a case drives
 * real editor UI and names the node whose rendered box must match between
 * the edited preview and the built export, pixel for pixel.
 */
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { routeFrameLocator, selectNode } from "./helpers";

export interface InvariantCase {
  name: string;
  /** Node whose rendered box is screenshot-compared (may differ from the edited node when the effect lands outside its border box, e.g. margins). */
  screenshotNode: string;
  apply: (page: Page) => Promise<void>;
  /** Visibility cases: the export always compiles a hidden node OUT entirely
   * (contract 6.1/6.2 — export has no edit mode, so hidden always means
   * gone), so there is nothing to pixel-diff — the invariant to check is
   * that the node is absent from export, not that it renders identically. */
  expectRemovedFromExport?: boolean;
  /** Reorder cases: the channel changes position, never appearance, so the
   * per-node pixel diff measures nothing and only picks up rasterization
   * noise. invariant.spec.ts's section-order test is the real assertion.
   * See the reorder case for the full reasoning — do NOT set this to quiet a
   * diff on any channel that changes how a node renders. */
  skipPixelDiff?: boolean;
}

/** Selects via a corner click, not the default center click: a section root
 * or a padded card wrapping several stacked children puts a CHILD at the
 * center of its own bounding box, so a plain click there selects that
 * child instead of the container (the same reason helpers.selectNode
 * special-cases "home.hero" — this generalizes it to every archetype). */
async function selectViaCorner(page: Page, nodeId: string): Promise<void> {
  const slug = nodeId.split(".")[0]!;
  await routeFrameLocator(page, slug)
    .locator(`[data-node-id="${nodeId}"]`)
    .click({ position: { x: 8, y: 8 } });
  // Confirm THIS node is selected, not just that some selection-outline is
  // visible — the invariant suite runs every case in one continuous session,
  // so an outline from the PREVIOUS case's node can already be on screen,
  // making a bare toBeVisible() check pass instantly without ever waiting
  // for React to actually commit the new selection (a real race: a drag
  // started right after would still carry the old node's closure).
  await expect(page.locator(".inspector-id")).toHaveText(nodeId);
}

/** Text channel: dblclick the preview node opens the inline overlay (both
 * selects and starts editing at once); Enter commits (PRD 3.1). Every text
 * case here targets a leaf Heading/Text node, so no corner-click is needed. */
function applyTextEdit(nodeId: string, text: string) {
  return async (page: Page) => {
    const slug = nodeId.split(".")[0]!;
    await routeFrameLocator(page, slug).locator(`[data-node-id="${nodeId}"]`).dblclick();
    const overlay = page.getByTestId("text-edit-overlay");
    await overlay.fill(text);
    await overlay.press("Enter");
  };
}

/** Layout channel: drag the move-handle a fixed, in-bounds delta (PRD 3.3). */
function applyLayoutMove(nodeId: string, dx: number, dy: number) {
  return async (page: Page) => {
    await selectViaCorner(page, nodeId);
    const box = (await page.getByTestId("move-handle").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 });
    await page.mouse.up();
  };
}

/** Visibility channel: the eye toggle ghosts the node in edit mode (PRD 3.4). */
function applyVisibilityToggle(nodeId: string) {
  return async (page: Page) => {
    await selectViaCorner(page, nodeId);
    await page.getByTestId("visibility-toggle").click();
  };
}

/** A tiny inline SVG: no network, deterministic bytes, and it renders at a
 * fixed size so the pixel-diff compares like for like. */
const REPLACEMENT_IMAGE =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><rect width='200' height='200' fill='%234f46e5'/></svg>";

/** Style channel: background swatch — same control regardless of archetype. */
function applyStyleSwatch(nodeId: string) {
  return async (page: Page) => {
    await selectViaCorner(page, nodeId);
    await page.getByTestId("swatch-background-color.semantic.accent").click();
  };
}

/** Pans right until the named route's frame leaves virtualization and mounts.
 *
 * Target-seeking rather than a fixed delta: cases run in one continuous
 * session and several of them pan the stage as a side effect (layout drags do
 * it invisibly; the image case pans deliberately), so any fixed offset is
 * correct only for whichever case happens to run first. Overshooting is as
 * fatal as undershooting — the frame leaves range on the other side.
 *
 * Canvas virtualization (PRD risk 2): a route frame renders a placeholder,
 * not a live iframe, until it's within a render-ahead margin of the
 * viewport (canvas.spec.ts's "narrow viewport" test exercises this same
 * mechanism directly) — this suite's home/about routes always start near
 * enough, but "support" (the 3rd frame, offset further right) does not at
 * this viewport width. Pans the stage left by a fixed delta well past the
 * minimum needed, before any case that touches a route whose frame may not
 * be mounted yet.
 *
 * The mouse position for the wheel event is deliberately the horizontal GAP
 * between two frames (FRAME_GAP, never covered by ANY frame's DOM at ANY
 * vertical scroll position — unlike a fixed (x,y) pixel guess), not a fixed
 * "background" point: earlier cases in this suite include real mouse drags
 * (applyLayoutMove), which were observed (live, via a throwaway debug
 * script) to leave the stage panned vertically by several hundred px as a
 * side effect — invisible to every case before this one, since none needed
 * pixel-accurate stage awareness afterward. A fixed (400, 60) guess that
 * was safely on empty background before those drags can land inside a LIVE
 * cross-origin iframe afterward, which silently swallows the wheel event
 * (it doesn't bubble to the stage) rather than erroring — the gap position
 * is immune to this because no frame ever occupies that column, at any Y. */
async function panUntilFrameMounted(page: Page, slug: string, deltaX = 400): Promise<void> {
  const frame = page.locator(`iframe[title="preview-${slug}"]`);
  // viewportWidth guards not just "mounted" (a live iframe exists once within
  // the render-ahead margin) but "actually on screen": a frame can enter the
  // DOM slightly before its bounding box overlaps the visible viewport, which
  // is invisible for the original rightward callers (about/support, panned
  // just far enough) but matters once this same helper is asked to pan back
  // LEFT to "home" from far to the right — several groups' worth of prior
  // panning means "mounted" and "on screen" are no longer the same moment.
  const viewportWidth = page.viewportSize()?.width ?? 0;
  for (let step = 0; step < 30; step += 1) {
    if ((await frame.count()) > 0) {
      const box = await frame.boundingBox();
      if (box !== null && box.x < viewportWidth && box.x + box.width > 0) return;
    }
    // Dispatched straight at the stage rather than via mouse position:
    // hit-testing is unreliable here because earlier cases move frames
    // around, so any fixed screen point can end up inside a live
    // cross-origin iframe, which swallows the wheel without erroring.
    await page.getByTestId("canvas-stage").dispatchEvent("wheel", { deltaX, deltaY: 0 });
    await page.waitForTimeout(60);
  }
  throw new Error(`frame "${slug}" never entered the viewport`);
}

export const INVARIANT_CASES: InvariantCase[] = [
  // ---------- hero ----------
  {
    name: "style: background token swatch on the section root",
    screenshotNode: "home.hero",
    apply: async (page) => {
      await selectNode(page, "home.hero");
      await page.getByTestId("swatch-background-color.semantic.accent").click();
    },
  },
  {
    name: "style: padding token stepper on the headline",
    screenshotNode: "home.hero.headline",
    apply: async (page) => {
      await selectNode(page, "home.hero.headline");
      await page.getByTestId("stepper-inc-padding").click();
    },
  },
  {
    name: "style: margin-top token stepper on the subheadline",
    screenshotNode: "home.hero",
    apply: async (page) => {
      await selectNode(page, "home.hero.subheadline");
      await page.getByTestId("stepper-inc-marginTop").click();
    },
  },
  {
    name: "style: off-scale custom background on the secondary CTA",
    screenshotNode: "home.hero.cta-secondary",
    apply: async (page) => {
      await selectNode(page, "home.hero.cta-secondary");
      await page.getByTestId("custom-toggle-background").click();
      await page.getByTestId("custom-input-background").fill("#ff5500");
      await page.getByTestId("custom-input-background").press("Enter");
    },
  },
  {
    name: "text: hero headline",
    screenshotNode: "home.hero.headline",
    apply: applyTextEdit("home.hero.headline", "An invariant-tested headline"),
  },
  {
    name: "layout: hero section moved via margin",
    screenshotNode: "home.hero",
    apply: applyLayoutMove("home.hero", 16, 16),
  },
  // No hero visibility case: hero is a single, non-repeatable section (no
  // sibling to hide instead), and every hero case above screenshots either
  // "home.hero" itself or a node whose test depends on "home.hero"'s total
  // height (the margin-top case observes parent height by design). Hiding
  // ANY hero child — even ghosted, so preview keeps its layout space per
  // PRD 3.4 — genuinely shrinks the export's rendered height once the
  // element is compiled out entirely (contract 6.2), which is correct
  // product behavior but incompatible with those height-dependent
  // screenshots in this suite's single accumulated-overrides pass. The
  // visibility channel's mechanism (both the literal-node removeElement
  // path and the list-item hidden/childHidden path) is still exercised
  // elsewhere in this matrix and by compiler/src/exporter.test.ts directly.

  // ---------- feature-grid (capabilities) ----------
  {
    name: "style: background swatch on a feature card",
    screenshotNode: "home.capabilities.feature-realtime-sync",
    apply: applyStyleSwatch("home.capabilities.feature-realtime-sync"),
  },
  {
    name: "text: feature-grid heading",
    screenshotNode: "home.capabilities.heading",
    apply: applyTextEdit("home.capabilities.heading", "Capabilities, invariant-tested"),
  },
  {
    name: "layout: a feature card moved via margin",
    screenshotNode: "home.capabilities.feature-one-click-import",
    apply: applyLayoutMove("home.capabilities.feature-one-click-import", 16, 0),
  },
  {
    name: "visibility: a feature card ghosted",
    screenshotNode: "home.capabilities.feature-role-based-access",
    apply: applyVisibilityToggle("home.capabilities.feature-role-based-access"),
    expectRemovedFromExport: true,
  },

  // ---------- cta-band ----------
  {
    // Screenshots the heading, not "home.cta-band" itself: cta-band's own
    // box height is the sum of its children (a vertical flex stack, like
    // hero), and this suite's visibility case below hides the button — still
    // occupying its layout space while ghosted (PRD 3.4) but genuinely gone
    // once compiled out for export (contract 6.2), which would make
    // "home.cta-band" itself taller in preview than in export. The heading
    // has no background of its own, so the section's background swatch is
    // still visible through it, and the heading's OWN box (unlike its
    // parent's) doesn't depend on a LATER sibling's presence.
    name: "style: background swatch on the cta-band section root",
    screenshotNode: "home.cta-band.heading",
    apply: applyStyleSwatch("home.cta-band"),
  },
  {
    name: "text: cta-band heading",
    screenshotNode: "home.cta-band.heading",
    apply: applyTextEdit("home.cta-band.heading", "An invariant-tested call to action"),
  },
  {
    name: "layout: cta-band subheading moved via margin",
    screenshotNode: "home.cta-band.subheading",
    apply: applyLayoutMove("home.cta-band.subheading", 0, 16),
  },
  {
    name: "visibility: cta-band button ghosted",
    screenshotNode: "home.cta-band.cta",
    apply: applyVisibilityToggle("home.cta-band.cta"),
    expectRemovedFromExport: true,
  },

  // ---------- pricing-tiers ----------
  {
    // Screenshots the tier's name, not the tier card itself: this suite's
    // visibility case below hides the same tier's badge — still occupying
    // its layout space while ghosted (PRD 3.4) but genuinely gone once
    // compiled out for export (contract 6.2), which would make the CARD
    // itself taller in preview than in export (same reason cta-band's style
    // case screenshots its heading instead of its own section root, above).
    name: "style: background swatch on the growth tier",
    screenshotNode: "home.pricing.tier-growth.name",
    apply: applyStyleSwatch("home.pricing.tier-growth"),
  },
  {
    name: "text: starter tier name",
    screenshotNode: "home.pricing.tier-starter.name",
    apply: applyTextEdit("home.pricing.tier-starter.name", "Starter (invariant-tested)"),
  },
  {
    name: "layout: scale tier moved via margin",
    screenshotNode: "home.pricing.tier-scale",
    apply: applyLayoutMove("home.pricing.tier-scale", 16, 16),
  },
  {
    name: "visibility: growth tier's badge ghosted",
    screenshotNode: "home.pricing.tier-growth.badge",
    apply: applyVisibilityToggle("home.pricing.tier-growth.badge"),
    expectRemovedFromExport: true,
  },

  // ---------- faq-accordion ----------
  {
    // Screenshots the answer, not the item's own box: verified (by sampling
    // background pixels directly, away from any edge) that the compiled
    // background color is byte-for-byte identical between preview and
    // export — the actual mismatch is confined to the item's own top edge,
    // a sub-pixel screenshot-boundary rounding artifact between the two
    // separate page renders, not a real difference. The answer sits inset
    // from that edge (below the heading), so its crop never touches it. The
    // visibility case below hides an answer inside the LAST item
    // (item-data-export, not item-trial-length), so this item's own content
    // never shrinks between preview and export, and nothing above it moves.
    name: "style: background swatch on a faq item",
    screenshotNode: "home.faq.item-trial-length.answer",
    apply: applyStyleSwatch("home.faq.item-trial-length"),
  },
  {
    name: "text: a faq question",
    screenshotNode: "home.faq.item-cancel-anytime.question",
    apply: applyTextEdit("home.faq.item-cancel-anytime.question", "Can I really cancel anytime?"),
  },
  {
    name: "layout: a faq item moved via margin",
    screenshotNode: "home.faq.item-cancel-anytime",
    apply: applyLayoutMove("home.faq.item-cancel-anytime", 0, 16),
  },
  {
    // The LAST item's answer (items run trial-length, cancel-anytime,
    // data-export), which matters more than just being "a different item"
    // from the cases above.
    //
    // A ghosted node keeps its layout space in preview (PRD 3.4) and is gone
    // from the export entirely (contract 6.2), so every sibling BELOW it sits
    // higher in export than in preview — a real, intended difference that
    // this suite must not mistake for a fidelity bug. While the shift is a
    // whole number of pixels it is invisible to a per-node screenshot; land
    // it on a fractional boundary and identical text rasterizes to different
    // sub-pixels (1.27% of pixels, found when the reorder case first changed
    // the section's absolute Y). Hiding inside the last item leaves nothing
    // below it to shift, so the fragility does not exist rather than being
    // tolerated. The visibility channel is asserted exactly as before, by
    // absence from the export.
    name: "visibility: a faq answer ghosted",
    screenshotNode: "home.faq.item-data-export.answer",
    apply: applyVisibilityToggle("home.faq.item-data-export.answer"),
    expectRemovedFromExport: true,
  },

  // ---------- social-proof (testimonials) ----------
  {
    // Screenshots the quote, not the card's own box: the card's own edges
    // are subject to the same sub-pixel screenshot-boundary rounding
    // artifact documented on the faq item case above (confirmed there by
    // sampling background pixels directly — the compiled color itself
    // matches exactly). The quote sits inset from the card's edges, so its
    // crop never touches them. The visibility case below hides a DIFFERENT
    // testimonial's (marcus, not priya) attribution, so priya's own content
    // never shrinks between preview and export either.
    name: "style: background swatch on a testimonial card",
    screenshotNode: "home.testimonials.testimonial-priya.quote",
    apply: applyStyleSwatch("home.testimonials.testimonial-priya"),
  },
  {
    name: "text: a testimonial quote",
    screenshotNode: "home.testimonials.testimonial-marcus.quote",
    apply: applyTextEdit("home.testimonials.testimonial-marcus.quote", "An invariant-tested quote."),
  },
  {
    // Screenshots the quote, not the card's own box: same sub-pixel
    // screenshot-boundary rounding artifact at the card's own edge
    // documented on the style case above. A margin change doesn't affect
    // the margined element's own box dimensions either way (margin is
    // outside the border box), so this loses no coverage — a child's box
    // staying pixel-identical is exactly as meaningful a confirmation as
    // the parent's would be, without the edge artifact.
    name: "layout: a testimonial card moved via margin",
    screenshotNode: "home.testimonials.testimonial-elena.quote",
    apply: applyLayoutMove("home.testimonials.testimonial-elena", 16, 0),
  },
  {
    // marcus, not priya: hiding priya's own attribution would shrink the
    // full card the style case above screenshots (quote comes before
    // attribution in marcus's card too, so the text case's screenshot of
    // marcus.quote is unaffected by hiding marcus.attribution).
    name: "visibility: a testimonial's attribution ghosted",
    screenshotNode: "home.testimonials.testimonial-marcus.attribution",
    apply: applyVisibilityToggle("home.testimonials.testimonial-marcus.attribution"),
    expectRemovedFromExport: true,
  },

  // ---------- contact-form (milestone 6.1: first interactive/handler-prop
  // archetype in this suite — Input/Textarea primitives, a typed onSubmit
  // handler prop, and a real <form> wrapper none of the original 6
  // archetypes exercise) ----------
  // ---------- image replace (7.7, PRD 3.5) ----------
  {
    // The image swap is a TEXT override with key "src" (PRD 3.5: content, not
    // style), so this case also proves the keyed variant of the text channel
    // survives compilation. Screenshots the image itself: its rendered box is
    // exactly what an image swap must keep identical between preview and export.
    name: "text(src): image replace on an Image node",
    screenshotNode: "about.intro.portrait",
    apply: async (page) => {
      await panUntilFrameMounted(page, "about");
      await selectViaCorner(page, "about.intro.portrait");
      await page.getByTestId("image-src-input").fill(REPLACEMENT_IMAGE);
      await page.getByTestId("image-src-input").press("Enter");
    },
  },

  // ---------- section reorder (PRD 3.3) ----------
  {
    // On "about", not "home", although home is the route with six sections.
    //
    // Every home section also carries a visibility case, and a ghosted node
    // keeps its layout space in preview (PRD 3.4) while the export compiles it
    // out entirely (contract 6.2). So on home, every node below a ghost
    // already sits at a different absolute Y in preview than in export — a
    // real and intended difference, invisible to a per-node screenshot only
    // while the offset stays a whole number of pixels. Moving a section
    // changes those offsets, and reordering home was measured flipping two
    // unrelated cases onto different pixel boundaries (a 1.27% text
    // rasterization diff, then a 1px crop difference) — noise that says
    // nothing about reorder.
    //
    // "about" carries no visibility case, so both its sections render at
    // identical positions on both sides and a reorder perturbs nothing. It
    // also has the page's FailedSectionPlaceholder sitting between the two
    // reorderable sections, making this the only end-to-end coverage of the
    // rule that a child with NO node id holds its slot rather than being
    // shuffled to an end or dropped (the exporter and the shim implement that
    // rule separately, so agreeing here is worth asserting).
    name: "sectionOrder: about values moved above the intro",
    screenshotNode: "about.values.heading",
    skipPixelDiff: true,
    apply: async (page) => {
      await panUntilFrameMounted(page, "about");
      await selectViaCorner(page, "about.values");
      await expect(page.getByTestId("reorder-position")).toHaveText("Section 2 of 2");
      await page.getByTestId("reorder-up").click();
      await expect(page.getByTestId("reorder-position")).toHaveText("Section 1 of 2");
    },
  },
  // Why this case is exempt from the pixel diff, and why that costs nothing:
  //
  // Reorder is the only channel that changes NOTHING about how a node renders
  // — only where it sits. A per-node screenshot frames the node's own box, so
  // it cannot see position at all. What needs proving is that preview and
  // export agree on ORDER, and invariant.spec.ts's section-order test asserts
  // that directly, against an explicitly expected sequence so it cannot pass
  // vacuously.
  //
  // That test is also sufficient, because the shim reorders the real DOM
  // rather than faking it with flex `order`: order-dependent CSS
  // (:first-child, nth-child, sibling combinators) therefore resolves against
  // the same DOM order on both sides. A visual-only reorder would have made
  // this exemption unsafe.

  {
    // Screenshots the heading, not "support.contact-form" itself: this
    // suite's visibility case below hides the submit button — still
    // occupying its layout space while ghosted (PRD 3.4) but genuinely gone
    // once compiled out for export (contract 6.2), which would make the
    // section's own box shorter in export than in preview (same reason
    // cta-band's style case screenshots its heading instead of its own
    // section root, above). Also the group's first case, so it pans the
    // stage left first (see panStageLeft) to mount "support"'s frame before
    // any contact-form case tries to interact with it.
    name: "style: background swatch on the contact-form section root",
    screenshotNode: "support.contact-form.heading",
    apply: async (page) => {
      await panUntilFrameMounted(page, "support");
      await applyStyleSwatch("support.contact-form")(page);
    },
  },
  {
    name: "text: contact-form heading",
    screenshotNode: "support.contact-form.heading",
    apply: applyTextEdit("support.contact-form.heading", "An invariant-tested heading"),
  },
  {
    name: "layout: contact-form description moved via margin",
    screenshotNode: "support.contact-form.description",
    apply: applyLayoutMove("support.contact-form.description", 0, 16),
  },
  {
    // Not the submit button: it's disabled by default (no field has been
    // filled by any case in this suite), and a real browser never dispatches
    // click events to a disabled element — Playwright's actionability check
    // waits for "enabled" forever. The message field has no such state.
    name: "visibility: contact-form message field ghosted",
    screenshotNode: "support.contact-form.message-field",
    apply: applyVisibilityToggle("support.contact-form.message-field"),
    expectRemovedFromExport: true,
  },

  // ---------- prompt-driven editing ----------
  {
    // An override authored by the agent must survive export exactly as one
    // authored by the canvas does. It compiles through the same channel and the
    // same exporter path, so this SHOULD be redundant — which is precisely why
    // it is worth asserting: if a prompt ever produced something the canvas
    // could not, this is where it would show up as a pixel difference.
    //
    // The prompt endpoint resolves its target route from the CURRENTLY
    // SELECTED node (App.tsx's submitEditPrompt: `selectedId === undefined ?
    // routes[0] : routeOf(selectedId)`), not from whichever frame the stage
    // happens to be panned to. By this point in the suite, selection and pan
    // both sit on "support" (the last case group above), so submitting
    // without first selecting a "home" node would send route: "support" and
    // the mock's home-shaped nodeId would fail validation as unknown on that
    // route. Pans back and selects explicitly so this case is self-contained
    // rather than order-dependent on what the previous case left behind.
    name: "prompt: agent-authored style override on the cta-band heading",
    screenshotNode: "home.cta-band.heading",
    apply: async (page) => {
      await panUntilFrameMounted(page, "home", -400);
      await selectNode(page, "home.cta-band.heading");
      await page.getByTestId("edit-prompt-input").fill("make the accent colour change");
      await page.getByTestId("edit-prompt-submit").click();
      await expect(page.getByTestId("edit-prompt-summary")).toBeVisible({ timeout: 20_000 });
    },
  },
];
