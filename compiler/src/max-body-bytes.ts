// compiler/src/max-body-bytes.ts
/**
 * The cap every body-reading endpoint in this package enforces BEFORE ever
 * accumulating a chunk or calling `JSON.parse` — `preview.ts`'s
 * `PUT /__overrides/<slug>` and `regen-api.ts`'s `readBody` (the five
 * `/__regen*`/`/__add-section`/`/__edit-prompt` endpoints).
 *
 * `proxyHttp` (server/src/preview-proxy.ts) PIPES a proxied request's body
 * straight to this process rather than buffering it, so the hosted server's
 * own memory is already bounded by ordinary TCP backpressure — a second cap
 * ahead of it would be a second thing to drift, and the module comment there
 * says so explicitly. The place the bytes actually accumulate, for BOTH the
 * hosted server (proxied) and the local, unauthenticated `preview.ts`
 * (direct), is here, in whichever handler collects the body into a Buffer[]
 * before parsing it — so this is also the only place bounding it protects
 * anything: past this cap the failure is an OOM'd preview CHILD, which is
 * the one process serving every other request for that project, not merely
 * "a large file got written."
 *
 * Exactly 1_000_000 — the same figure server/src/router.ts's own
 * `MAX_BODY_BYTES` uses, and deliberately for the same reason (an unbounded
 * body is a trivial memory-exhaustion vector). The two are NOT the same
 * binding: compiler/ has no dependency on server/, and must not gain one —
 * `compiler/scripts/preview.ts` stays unauthenticated and local regardless
 * of what server/ does (CLAUDE.md). Keep the two numbers equal on purpose;
 * `server/src/router.test.ts` pins the pair against drift from that side.
 */
export const MAX_BODY_BYTES = 1_000_000;
