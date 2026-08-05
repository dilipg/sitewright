// server/src/router.ts
/**
 * A route table over node:http. No framework — this codebase hand-rolls its
 * plumbing (see compiler/src/zip.ts), and a router small enough to read in one
 * screen is easier to audit than a dependency.
 *
 * The table IS the allowlist. Deny-by-default is not a middleware that must be
 * remembered; an unregistered path simply has nowhere to go. That matters here
 * because this codebase added four endpoints in its last two slices.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 1_000_000;

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { url: URL; params: Record<string, string> },
) => Promise<void> | void;

export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  handler: Handler;
}

/**
 * A route path may declare at most ONE `:name` segment. Matching stays
 * segment-exact: a parameter captures exactly one segment and never spans a
 * `/`. That restriction is what preserves the allowlist property — if `:id`
 * could swallow `abc/def`, registering one route would silently expose every
 * path beneath it, including paths with their own intended authorization rule.
 */
interface CompiledRoute {
  route: Route;
  segments: string[];
  paramName: string | null;
  paramIndex: number;
}

function compile(route: Route): CompiledRoute {
  const segments = route.path.split("/");
  const indices = segments.flatMap((s, i) => (s.startsWith(":") ? [i] : []));
  if (indices.length > 1) {
    throw new Error(`route ${route.method} ${route.path} declares more than one parameter`);
  }
  const paramIndex = indices[0] ?? -1;
  return {
    route,
    segments,
    paramName: paramIndex === -1 ? null : segments[paramIndex]!.slice(1),
    paramIndex,
  };
}

function match(compiled: CompiledRoute, method: string, pathname: string) {
  if (compiled.route.method !== method) return null;
  const actual = pathname.split("/");
  if (actual.length !== compiled.segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < compiled.segments.length; i += 1) {
    if (i === compiled.paramIndex) {
      const raw = actual[i]!;
      // An empty segment is not a value: "/api/thing/" must not resolve with
      // an empty id, which downstream would look up row "" and 404 anyway —
      // but only after a database read on unvalidated input.
      if (raw === "") return null;
      // decodeURIComponent throws URIError on a malformed escape (e.g. "%ZZ").
      // This call sits outside both of the listener's try/catch blocks, so an
      // uncaught throw here would become a rejected promise on an async
      // listener that node:http never awaits — no response is ever written,
      // and the connection hangs until a timeout. A malformed percent-escape
      // is a malformed path: treat it as a non-match so the request falls
      // through to the normal 404, the same honest answer a missing or extra
      // segment gets. Never pass the raw undecoded value through instead —
      // a handler expects a decoded string, not a percent-escaped one.
      try {
        params[compiled.paramName!] = decodeURIComponent(raw);
      } catch {
        return null;
      }
      continue;
    }
    if (actual[i] !== compiled.segments[i]) return null;
  }
  return params;
}

/**
 * Before parameterised routes existed, string equality on `${method} ${path}`
 * WAS pattern equality: every segment was literal, so two equal strings and
 * two colliding patterns were the same fact. They no longer are — `match()`
 * below never looks at a parameter's NAME, only its position, so "GET
 * /a/:x" and "GET /a/:y" match exactly the same requests and the second is
 * unreachable the instant the first is registered. As raw strings, though,
 * they are two different keys. Every `:name` segment is normalised to the
 * same placeholder here so the dedupe key reflects the pattern a request is
 * actually matched against, not the literal characters used to write it.
 */
function dedupeKey(route: Route): string {
  const normalizedPath = route.path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? ":param" : segment))
    .join("/");
  return `${route.method} ${normalizedPath}`;
}

export function createRequestListener(routes: Route[]) {
  // The table IS the allowlist, and `.find()` below returns the first match
  // — so two routes matching the same request pattern would be silently
  // shadowed rather than rejected. Checked once, at construction, not per
  // request: the route table is fixed for the process's lifetime, and a
  // duplicate is a wiring bug that should fail the moment the listener is
  // built, not get buried in whichever handler happened to register first.
  const seen = new Set<string>();
  for (const route of routes) {
    const key = dedupeKey(route);
    if (seen.has(key)) {
      throw new Error(`duplicate route registered: ${route.method} ${route.path}`);
    }
    seen.add(key);
  }

  // Compiled once, outside the returned listener: the route table is fixed
  // for the process's lifetime, so per-request recompilation would be pure
  // waste. Literals and parameterised routes are held in separate arrays —
  // not sorted together — so that a literal always wins regardless of the
  // order routes were registered in; see the match order in the listener.
  const compiled = routes.map(compile);
  const literals = compiled.filter((c) => c.paramName === null);
  const parameterised = compiled.filter((c) => c.paramName !== null);

  return async function listener(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Constructing the URL can throw (a malformed Host header, e.g. "a b" or
    // "a:99999999", makes `new URL` throw TypeError: Invalid URL). That must
    // never escape this function: node:http has no default handler for a
    // rejected request-listener promise, so an uncaught throw here takes down
    // the whole process, not just this one request. A request with an
    // unparseable Host is malformed — answer 400, never fall back to a
    // default host, which would silently address the request somewhere the
    // client never asked for.
    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      sendJson(res, 400, { error: "bad request" });
      return;
    }
    // Exact match, never prefix: prefix matching is how a guard on one path
    // accidentally covers — or fails to cover — a neighbouring one. Literals
    // are tried before parameterised routes so a literal always wins, no
    // matter which order the two were registered in.
    const method = req.method ?? "";
    let found: { route: Route; params: Record<string, string> } | null = null;
    for (const c of literals) {
      const params = match(c, method, url.pathname);
      if (params !== null) { found = { route: c.route, params }; break; }
    }
    if (found === null) {
      for (const c of parameterised) {
        const params = match(c, method, url.pathname);
        if (params !== null) { found = { route: c.route, params }; break; }
      }
    }
    if (found === null) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    try {
      await found.route.handler(req, res, { url, params: found.params });
    } catch {
      // Deliberately no detail: a stack trace in a response body leaks paths,
      // versions, and sometimes secrets.
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
      } else {
        // Headers are already on the wire, so no status or body can be sent
        // at this point — but the connection must still be closed. Ending
        // with no chunk is the honest signal: a truncated response, not a
        // hang until the client's socket/idle timeout.
        res.end();
      }
    }
  };
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Bounded: an unbounded body is a trivial memory exhaustion.
    if (size > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    // Split on the FIRST '=' only — a value may legitimately contain more.
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  options: { maxAgeSeconds?: number; secure: boolean },
): string {
  const parts = [`${name}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  // Lax rather than Strict: the preview iframe navigates same-site, and Strict
  // would drop the cookie on those requests (spec, decision 12).
  if (options.secure) parts.push("Secure");
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`);
  return parts.join("; ");
}
