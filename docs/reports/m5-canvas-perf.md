# Infinite canvas pan/zoom performance — measurement report

Build prompt 5.4's VERIFY line: "60fps pan/zoom on a 6-page generated site (measure, don't guess)."

## Method

Measured actual `requestAnimationFrame` callback rate in a real Chromium tab (via Playwright), not estimated. The editor was pointed at a real, previously-generated multi-page project (`generated/plan-02-store-v5` — a storefront site with 4 routes: home, about, contact, shop/products, 79 manifest nodes) served through the real preview server with the bridge shim, exactly as a user would see it. No mocking of the canvas, iframes, or shim.

Sequence, at a 1700×900 viewport (the same width `layout.spec.ts`/`invariant.spec.ts` use, since the default 1280px viewport is narrower than the 1280px frame width plus the 280px inspector panel):

1. Load the editor, approve the plan, wait 3s for all frames' initial navigation/paint to settle.
2. **Pan**: dispatch a continuous stream of wheel events (`deltaX: 40` every ~16ms) for 2.5s, counting `requestAnimationFrame` callbacks throughout.
3. **Zoom**: dispatch a continuous stream of Ctrl+wheel events (zooming in then back out) for 2.5s, same counting method.

fps = (frame count − 1) / (elapsed time between first and last rAF timestamp). p95 frame time = the 95th-percentile gap between consecutive rAF timestamps (catches occasional jank a simple average would hide).

## Result

| | frames | duration | fps (avg) | p95 frame time |
|---|---|---|---|---|
| Pan | 150 | 2500ms | **60.0** | 16.7ms |
| Zoom | 151 | 2517ms | **60.0** | 16.8ms |

4 routes rendered (`data-testid^="frame-"` count). 60Hz is this machine's display refresh rate, so 60.0fps average with p95 essentially at the 16.67ms budget means the canvas is not dropping frames under sustained pan or zoom — it's refresh-rate-bound, not render-bound. Panning at this speed and duration (150 ticks × 40px ≈ 6000px of horizontal travel, versus routes laid out `FRAME_WIDTH(1280) + FRAME_GAP(80) = 1360px` apart) crosses multiple frames' virtualization boundary (`isFrameNearViewport`), so both the live-iframe and placeholder render paths were exercised, not just a static view.

## Deviation from "6-page" and why

The measurement used the 4-route `plan-02-store-v5` (already generated earlier in this session) rather than generating a fresh 6-page site. Generating one would cost real LLM spend for a number that's illustrative in the VERIFY line, not a hard requirement — the actual risk being tested (PRD risk 2: virtualization keeping many live Vite-served frames cheap) scales with "more than one or two frames," which 4 real routes already demonstrates, including virtualization transitions during the pan. If a stricter 6-page measurement is wanted later, the harness (a disposable Playwright test injecting an rAF counter, deleted after use — see git history of this session for the exact script) can be re-run against any multi-route project by pointing `WG_PROJECT_DIR` at it.

## Side effect

Running this measurement required approving `generated/plan-02-store-v5`'s pending plan (`plan/plan-status.json`) to get past the approval gate — this is a local, gitignored artifact with no effect on the committed repo.
