# Milestone 6.4 — developer handover trial

Milestone 6's exit criterion: *"handover trial completes without the developer
rewriting any generated component."*

The build plan permits "a real frontend developer **or** a fresh Claude Code
session with no project context" as the subject. Both trials used the latter: a
cold agent whose entire working world was an extracted export zip in a
directory outside the repository, explicitly instructed not to look outside it
(no generator, no contract docs, no `CLAUDE.md`).

The task, from the build plan: **"wire the cart to a fake REST API
(json-server), using only the export and its HANDOVER.md."**

## Result

| | Trial 1 | Trial 2 |
|---|---|---|
| Component rewrites | **none** | **none** |
| Files touched under `src/pages/*/sections/` or `src/primitives/` | 0 | 0 |
| Cart working against a live API | yes | yes |
| `npm run build` clean | yes | yes |

**Exit criterion met on both runs.** The developer replaced the cart's entire
data source with a live REST API — fetch on mount, `DELETE` on remove with the
UI recomputing, `POST` on checkout — and never opened `CartContents.tsx`.

Trial 1's own words, which are the most useful single sentence in this report:

> The presentational/handler split is the real thing. […] I replaced its entire
> data source with a live REST API and never opened the file to edit it. […] My
> complaints are all about the *width* of that seam — not one of them is about
> the shape of it.

That distinction is what makes the result meaningful rather than lucky. Trial 1
twice considered editing the component (for a loading state, and to disable the
checkout button during a request) and each time found a container-side
workaround. Those two near-misses became fixes below, so trial 2 would not have
to work around them.

## Friction found in trial 1, and what it became

Nine findings. Classified per the build prompt into archetype-template fixes,
HANDOVER.md-generator fixes, and — a category the prompt did not anticipate —
generated-shell and scaffold bugs.

### Archetype-template fixes

| Finding | Fix |
|---|---|
| An empty cart still rendered the Divider, `Subtotal $0`, and a **live** checkout button. The doc promises "the component needs no changes", which was true, and was also why the developer had to defend against the component in their container. | `cart-drawer.md` now renders the subtotal/checkout block only when there are visible items, and the Structure prose calls the old behaviour a bug rather than a layout. |
| No way to reflect an in-flight request. `CartDrawerProps` had no `disabled`, though the `Button` primitive supports it one layer down — so a double-submit guard could only be a click that silently does nothing. | `checkoutDisabled?: boolean` forwarded to the checkout Button's own `disabled`. Optional, so mock data never sets it. |
| The component does no arithmetic, so a removed line item leaves a stale subtotal — correct as a design choice, undocumented as a consequence, and a silent wrong-number bug for anyone who wires `onRemoveItem` and stops. | Stated in both `cart-drawer.md`'s Structure prose and HANDOVER.md section 1. |

### HANDOVER.md-generator fixes

The largest cluster. Section 1's central claim was **actively wrong** for the
one case the trial exercised.

| Finding | Fix |
|---|---|
| *"Swapping mock data for a real source (CMS, API, database) means replacing the data file's export"* is impossible: the file exports a module-level `const`, which cannot hold a promise or react to a change. The doc predicted a one-line change; reality was a container plus a derived type. | Section 1 now separates static text (data file) from async/stateful data (page container), and says why the data file cannot serve the latter. |
| There was no documented home for stateful code, and the only candidate was labelled "don't": every `pages/*/index.tsx` carries *"Page assembly only, no styling decisions."* The file that must hold the logic was the file telling you not to. | Section 1 names `src/pages/<route>/index.tsx` as the integration point and clarifies that the docblock means keep *styling* out, not logic. |
| **A list item's `key` silently becomes part of the canvas node-id namespace** (`<section-id>.item-${item.key}`). Slug keys kept ids stable by luck; integer database ids would have produced `…item-1` — exactly the positional addressing the architecture exists to prevent, invisibly, from a one-word choice in `db.json`. Trial 1 called this the most consequential thing it found. | New section 4 devoted to it, naming the failure mode and the rule (stable human-meaningful slugs, never integers or indices). |
| No loading/error seam exists and nothing warned about it. An empty list is indistinguishable from a loading list, so anyone wiring a fetch ships a **flash of "your cart is empty"** on every load. Trial 1 funnelled all three states through `emptyMessage`, which it correctly called an abuse of a content prop. | Section 1 states the absence and the flash, and says to gate on a loading flag in the container. |
| `src/lib/` ownership was undefined — the trial added a file there without knowing whether regeneration would clobber it. | New section 5: a path-by-path ownership table. |
| `HANDOVER.md` says "Generated by the exporter", so the trial assumed a re-export clobbers it and wrote its notes elsewhere — correctly, but by inference. | Section 5 states it explicitly. |
| `design-inventory.json` and `manifest.json` were never mentioned. The trial found the former by running `ls` and called it one of the two most useful files in the package; the latter is 38 KB of unexplained JSON in the root. | Both documented in section 5. |
| **The dev-loop trap that cost the most time.** json-server rewrites `db.json`; `db.json` sits in the Vite root; the write triggers a full reload that destroys React state mid-interaction. It does not present as a config problem — it presents as "my confirmation message doesn't render", and the reload refetches so the *data* looks correct. | Section 6 warns about it and gives the `server.watch.ignored` fix. Also notes `tsconfig` excludes `vite.config.ts` from the typecheck. |

### Generated-shell and scaffold bugs

Neither category was in the build prompt's list, and both are worse than most
of the documentation gaps.

| Finding | Fix |
|---|---|
| **Two shipped bugs in nine lines of generated shell.** `Nav.tsx` emitted raw `<a href>` for internal routes, so every nav click was a full document reload — for an API-backed cart, a refetch and total loss of client state on every navigation, despite `main.tsx` correctly wiring `BrowserRouter`. And it mapped over *all* routes, so the nav shipped a dead link to the literal URL `/product/:id`. | The Shell Agent's prompt taught both bugs in its own canonical example. It now uses react-router `Link` and filters parameterized routes, with the reasoning stated in the machine-checked rules. |
| Every generated site shipped the **fixture's identity**: `<title>Acme Analytics</title>` and `"name": "acme-landing-fixture"`, on a site otherwise entirely about a coastal candle shop. The first thing anyone sees in a browser tab. | New deterministic `brand_scaffold` step (no model involved, same category as `routes.ts`) stamps the brief's brand onto `index.html` and `package.json`. |

### Accepted, not fixed

**`priceLine: "$32 × 1"`.** The template deliberately combines price and
quantity into one mock-data string, because joining two fields with a literal
`×` in JSX is a hardcoded user-visible string that gate 5 rejects — and the
component documents that reasoning. Trial 1's critique is nonetheless correct:
the hardcode does not disappear, it *relocates* into whoever supplies the data,
so a currency symbol and a separator now live in a page container, per page,
unreachable from tokens, and duplicated the moment a second surface shows a
price. The trial's proposal — `unitPrice: number` + `quantity: number` behind
one shared formatting helper — is better, and would still pass gate 5 (the
literal moves to `src/lib/`, outside gate 5's section-JSX scope).

Not done here because it needs a shared formatting helper in the scaffold that
no agent currently owns, plus a coordinated change across every price-bearing
archetype. Filed for milestone 7. There is also no currency or locale anywhere
in the token set, which is the same gap seen from the other end.

## Trial 2

Run against a **freshly generated** site (not a re-export), so the
template, shell and scaffold fixes were all exercised rather than assumed.

**Result: `COMPONENT REWRITES: no`.** `CartContents.tsx` byte-for-byte
untouched; every prop needed (`items`, `subtotal`, `checkoutLabel`,
`checkoutDisabled`, `onRemoveItem`, `onCheckout`) already existed at the right
granularity. The cart loads 3 items from the API, removing `salt-air-linen`
drops the row and recomputes `$124 -> $68` with the server agreeing, and
checkout posts an order and empties the cart. `npm run build` green.

### The fixes were used, not merely present

Trial 2 was a different agent that never saw trial 1's findings, which makes
its report the actual test of whether each fix worked. Every one was picked up:

- **The node-id/data-key warning changed the developer's schema design.** In its
  own words: *"This directly changed my schema design: I made json-server's
  primary key the slug (`"id": "driftwood-shore"`) instead of `1, 2, 3`.
  Verified it worked -- the rendered DOM still carries
  `data-node-id="cart.cart-contents.item-driftwood-shore"`. Without that
  paragraph I'd have used integer ids by reflex and silently destroyed the
  canvas addressing."* This is the exact failure the warning was written to
  prevent, prevented, by someone who did not know it was being tested.
- **The container-pattern rewrite of section 1** *"pre-empted my single biggest
  decision and is why I touched no generated component."*
- **The "no arithmetic / no loading state" warnings**: *"Both were true and both
  would have been bugs. I wrote the loading gate because of line 16, not after
  shipping a flash of 'your cart is empty'."*
- **`checkoutDisabled`** was found and used for the double-submit guard,
  measured mid-flight as `{"label":"Placing order...","disabled":true}`.
- **The dev-watch trap warning** was called *"worth more than the rest of the
  document combined"* -- and the agent went further than the doc by testing it:
  it removed the fix, instrumented the page, and measured
  `markerSurvived: false, topLevelNavigationsAfterClick: 1`. It then found the
  failure mode the doc had understated: the cart still *looks* correct after the
  reload because the remount re-fetches, so the damage only shows on state that
  is not server-backed -- its post-checkout confirmation banner never appeared
  at all.
- The shell and scaffold fixes simply stopped being findings: no dead
  `/product/:id` link, no full-page reloads, no "Acme Analytics" in the tab.

### Residual friction trial 2 found

Passing the exit criterion did not mean a clean report. Four gaps were cheap
doc-generator fixes and were made immediately:

| Finding | Fix |
|---|---|
| Section 2 offered a choice that isn't one: replace the stub in the mock data file *or* pass your own handler. For async work the first is impossible, and section 1 says so -- the document contradicted itself. | Section 2 now distinguishes sync (data file) from async (container), and points at section 1. |
| `checkoutDisabled` existed and was listed, but nothing said it *is* the double-submit guard. The developer found that by reading the component, not the doc. | Section 2 now tells the reader to check the props interface for a companion `…Disabled?` flag and says what it is for. |
| React `StrictMode` double-fires every mount effect, so an unguarded `useEffect` fetch shows a spurious error on first load. The agent confirmed the double request. Conspicuous omission in a doc that warns about subtler traps. | Documented in section 6. |
| The watch warning understated itself: a locked file in the root can **crash the dev server**, not just reload the page. | Section 6 broadened to "keep anything that writes to disk out of the project root", with the reload-hides-the-damage explanation. |

Also fixed: the package shipped **no `.gitignore`**, so `dist/` and
`node_modules/` were untracked-but-unignored out of the box. Added to the
scaffold.

### Deferred to milestone 7, with evidence from both trials

- **`priceLine` composition.** Both trials independently reached the same
  conclusion: refusing to hardcode `×` in JSX does not remove the string, it
  *relocates* it into a page container with no override coverage. Trial 2:
  *"The rule pushed the string one file to the left rather than eliminating
  it."* Needs a shared formatting helper plus a coordinated change across every
  price-bearing archetype, and there is still no currency or locale anywhere in
  the token set.
- **No status primitive.** The doc correctly tells you to gate on a loading flag,
  but `design-inventory.json` has no spinner, skeleton or alert, and the page
  container's own docblock disclaims styling decisions -- so the developer
  hand-composed status markup in a file that says not to.
  `FailedSectionPlaceholder.tsx` proves the generator *can* emit a status
  surface; there just isn't one for runtime states.
- **Props-interface shape.** `items`, `subtotal` and both handlers are
  *required* on the props interface, so a data file typed as the full props must
  keep declaring values the container then discards -- stale `"$124"` and dead
  `console.log` stubs that still read as authoritative. Both trials invented a
  derived type (`Omit<>`, then `Pick<>`) to escape it. A generated
  `…Copy`/`…Content` type would remove the guesswork.
- **No per-item pending seam.** There is no `item.disabled` or per-row pending
  prop, so trial 2 went optimistic (the row unmounts on click, making a
  double-click structurally impossible) and noted the user gets no feedback
  against a slow API.
- Minor: no `.env.example` or documented API-base-URL convention.

## What this trial says about the architecture

The result worth keeping is narrow and real: **a machine-generated
presentational component, handed to a developer with no context, absorbed a
complete swap from mock data to a live REST API without being edited.** Two
independent cold runs, zero component rewrites.

Everything that went wrong was either documentation (the seam existed; the doc
described it incorrectly or not at all) or the width of a seam (the component
was right to own no state; it just didn't forward a `disabled` it already had
one layer down). Nothing found in either trial suggested the props/mock-data
seam itself is the wrong shape — which is the claim milestone 6 needed to test,
and the one thing a passing test suite could never have told us.

The uncomfortable finding is the ratio: **the two most severe bugs were in nine
lines of generated shell and two lines of scaffold**, not in the 20-archetype
catalog that received nearly all of milestone 6's attention. A dead nav link
and a full-page-reload SPA are worse handover defects than anything the section
templates produced, and no gate could have caught either, because both are
valid TypeScript that builds cleanly. Only a developer trying to *use* the
output found them.
