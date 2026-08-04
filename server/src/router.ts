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
  ctx: { url: URL },
) => Promise<void> | void;

export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  handler: Handler;
}

export function createRequestListener(routes: Route[]) {
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
    // accidentally covers — or fails to cover — a neighbouring one.
    const route = routes.find((r) => r.method === req.method && r.path === url.pathname);
    if (route === undefined) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    try {
      await route.handler(req, res, { url });
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
