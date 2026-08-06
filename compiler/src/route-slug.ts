// compiler/src/route-slug.ts
/**
 * The shape a bare route slug — a page's directory name under `src/pages/` —
 * is allowed to take. Anything else (a `..` segment, a `/`, an uppercase
 * letter, an empty string) must never reach a `path.join` call: `join`
 * normalises `..` sequences, so an unvalidated slug can walk a filesystem
 * path outside the project root it was meant to stay inside. Found in
 * review: `compiler/src/regen-api.ts`'s `snapshotRoute` joined a
 * proxied-verbatim `route`/`section` field straight into
 * `join(root, "src", "pages", routeSlug)` with no check at all, so
 * `routeSlug = "../../../../victim/src"` escaped the project root before the
 * request even reached its mock/real branch.
 *
 * One definition, two call sites, so neither can drift from the other:
 * `preview.ts`'s `/__overrides/<route-slug>` endpoint (the original site this
 * regex was written for) and `regen-api.ts`'s `route`/`section`-accepting
 * endpoints (added by the review fix above).
 */
export const ROUTE_SLUG = /^[a-z0-9-]+$/;
