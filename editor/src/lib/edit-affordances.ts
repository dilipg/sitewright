/**
 * HOW EACH EDIT CHANNEL IS ACTUALLY REACHED, in the user's own words.
 *
 * WHY THIS MODULE EXISTS (dogfood finding G4, the most important one of the
 * run). A tester drove the whole product and concluded that **text editing did
 * not exist**, then found it only by reading the source. Everything about the
 * editing surface pointed away from the truth:
 *
 *  - The inspector lists `EDITABLE CHANNELS  text style layout visibility` as
 *    pills that look exactly like buttons (`<span class="badge">`, `cursor:
 *    auto`), so the one honest status display in the panel read as four broken
 *    controls.
 *  - The panel, scrolled top to bottom, contains **no text field**: only
 *    Visibility, Variant, Color, Typography, Spacing. Every channel except
 *    `text` has a visible control, which makes the missing one read as absent
 *    rather than as differently-reached.
 *  - Text editing is **double-click the node**, and nothing on screen said so.
 *    The only hint anywhere was "Click an element in the preview to select it."
 *
 * THE FIX IS TO TEACH THE GESTURE, NOT TO FAKE A FIELD, and that is a decision
 * rather than an economy. An inspector text input would have to be pre-filled
 * with the node's current text, and **the parent document cannot know it**: the
 * shim sends the rendered text only on `dblclick` (`compiler/src/shim/
 * protocol.ts`'s `NodeHitMessage.text`, "sent only for dblclick"), the preview
 * is cross-origin in local mode, and `compiler/` is outside this fix's scope. A
 * field that opened empty would commit an empty text override on blur and
 * silently wipe the node's copy — trading an undiscoverable channel for a
 * data-losing one. So the gesture is named at all three places a user looks:
 * on hover over the element, on selection in the inspector, and beside the
 * channel list itself.
 *
 * EVERY STRING LIVES HERE, not in the JSX, for the reason `GenerationProgress`
 * and `KeySettings` already established: this workspace has no React testing
 * library and may not add one ("no new runtime dependencies"), so wording
 * inside a component body is untestable by construction. Wording is the entire
 * behaviour of this fix, so all of it is exported and asserted exactly.
 */

/**
 * The four P0 edit channels a manifest node can declare (contract 6.1), plus
 * `sectionOrder` — which never appears in a node's `editable` list (it is a
 * PAGE-level channel keyed by route slug, 7.5) but is reachable from the same
 * inspector, so a user who reads the list still needs to know where it lives.
 */
export const CHANNEL_GESTURES: Readonly<Record<string, string>> = {
  text: "Double-click the element on the canvas.",
  style: "The colour, type and spacing controls below.",
  layout: "Drag the element, or one of its handles, on the canvas.",
  visibility: "The Visible / Hidden button below.",
  sectionOrder: "The Move up / Move down buttons below.",
};

/**
 * How to make an edit on `channel`, or `undefined` for a channel this build
 * does not know.
 *
 * `undefined` rather than a generic fallback on purpose: a channel added to the
 * contract without being added here must render as a bare label (today's
 * behaviour, no worse) rather than as confident advice that points nowhere.
 */
export function describeChannelGesture(channel: string): string | undefined {
  return CHANNEL_GESTURES[channel];
}

/**
 * Beside the channel list, because the list itself is what a tester misread as
 * a row of buttons. It says the two things the pills cannot: that they are a
 * statement about the element, and that the gesture for each one is written
 * next to it.
 */
export const CHANNEL_LIST_NOTE =
  "What this element allows — a status, not buttons. Each one says how to make that edit.";

/**
 * The selection-time hint, at the TOP of the inspector rather than below the
 * controls: a tester who scrolls looking for a text field must meet this before
 * they conclude there is none.
 */
export const TEXT_EDIT_HINT = "Double-click this element on the canvas to edit its text.";

/**
 * The hover-time hint, drawn beside the node label on the canvas. This is the
 * one that needs no reading and no scrolling — it appears under the cursor, on
 * the element itself, at the moment the user is already pointing at it.
 *
 * Short by necessity: it sits in a one-line pill against real page content, and
 * the outline it belongs to is `pointer-events: none`, so it can never be the
 * thing the user clicks.
 */
export const HOVER_TEXT_EDIT_HINT = "double-click to edit text";

/** The hover hint for a node with these editable channels, or `undefined` when
 *  the node has no text channel and the hint would be a lie. */
export function hoverHintFor(editable: readonly string[] | undefined): string | undefined {
  return editable !== undefined && editable.includes("text") ? HOVER_TEXT_EDIT_HINT : undefined;
}

/**
 * The empty-inspector line. It KEEPS the old sentence and adds the gesture:
 * "click to select" was true and is still needed, it was just the whole of what
 * the app ever said about editing.
 */
export const EMPTY_SELECTION_HINT =
  "Click an element in the preview to select it. Double-click text to edit it.";

/**
 * Dogfood finding G8: a Margin Top edit made with the inspector's Spacing
 * stepper persists as `{"channel":"style","value":{"marginTop":"space.6"}}`
 * while the panel advertises a separate `layout` channel — so the override file
 * appears to contradict the UI.
 *
 * Both are correct and neither is a bug: padding and margins ARE style
 * properties on the style channel, and the `layout` channel is the
 * drag/resize gesture, which writes size and position deltas (contract 6.1).
 * Only the UI was silent about which is which, which is what this says.
 */
export const SPACING_CHANNEL_NOTE =
  "Padding and margins are saved on the style channel. The layout channel is the drag-and-resize gesture on the canvas.";
