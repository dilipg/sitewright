// server/src/router.test.ts
/**
 * Deny-by-default lives here. The route table IS the allowlist: an
 * unregistered path is unreachable, so a new endpoint cannot be exposed by
 * forgetting to add a guard — it has to be added deliberately.
 */
import { describe, expect, it } from "vitest";
import {
  createRequestListener, parseCookies, readJsonBody, serializeCookie, type Route,
} from "./router.ts";

/** Drives the listener without opening a socket. */
async function call(routes: Route[], method: string, path: string) {
  const listener = createRequestListener(routes);
  const chunks: string[] = [];
  let status = 0;
  let endCalls = 0;
  const headers: Record<string, string | string[]> = {};
  const res = {
    // Stateful, matching real ServerResponse semantics: false until the
    // first writeHead, then true — this is what lets the catch block's
    // `!res.headersSent` branch actually be exercised by a test.
    headersSent: false,
    writeHead(code: number, hdrs?: Record<string, string | string[]>) {
      status = code;
      Object.assign(headers, hdrs ?? {});
      res.headersSent = true;
      return res;
    },
    setHeader(name: string, value: string | string[]) { headers[name.toLowerCase()] = value; },
    end(chunk?: string) { endCalls += 1; if (chunk !== undefined) chunks.push(chunk); },
  };
  const req = { method, url: path, headers: { host: "localhost" } };
  await listener(req as never, res as never);
  return { status, headers, body: chunks.join(""), endCalls };
}

const ok: Route = {
  method: "GET",
  path: "/api/ok",
  handler: (_req, res) => { res.writeHead(200); res.end("yes"); },
};

describe("createRequestListener", () => {
  it("routes a registered path", async () => {
    expect((await call([ok], "GET", "/api/ok")).body).toBe("yes");
  });

  it("404s an unregistered path — deny by default", async () => {
    expect((await call([ok], "GET", "/api/secret")).status).toBe(404);
  });

  it("404s a registered path on the wrong method", async () => {
    // Otherwise a GET-only route silently accepts POSTs.
    expect((await call([ok], "POST", "/api/ok")).status).toBe(404);
  });

  it("ignores the query string when matching", async () => {
    expect((await call([ok], "GET", "/api/ok?next=/somewhere")).status).toBe(200);
  });

  it("does not match by prefix", async () => {
    // "/api/ok" must not answer for "/api/okay" — prefix matching is how a
    // guard on one path accidentally covers, or fails to cover, another.
    expect((await call([ok], "GET", "/api/okay")).status).toBe(404);
  });

  it("returns 500 and no detail when a handler throws", async () => {
    // A stack trace in a response body leaks paths and versions.
    const boom: Route = { method: "GET", path: "/api/boom", handler: () => { throw new Error("db password is hunter2"); } };
    const result = await call([boom], "GET", "/api/boom");
    expect(result.status).toBe(500);
    expect(result.body).not.toContain("hunter2");
  });

  it("400s a malformed Host header instead of throwing out of the listener", async () => {
    // The actual guarantee: the listener's returned promise must RESOLVE, not
    // reject. node:http has no handler for a rejected listener promise, so a
    // reject here would (in the real server) escape uncaught and kill the
    // process for every user, not just this request. `new URL(..., "http://a
    // b")` throws TypeError: Invalid URL before this fix — the guard must
    // catch it at construction, before the try/catch around the handler.
    const listener = createRequestListener([ok]);
    const chunks: string[] = [];
    let status = 0;
    const res = {
      headersSent: false,
      writeHead(code: number, _hdrs?: Record<string, string | string[]>) {
        status = code; res.headersSent = true; return res;
      },
      setHeader() {},
      end(chunk?: string) { if (chunk !== undefined) chunks.push(chunk); },
    };
    const req = { method: "GET", url: "/api/ok", headers: { host: "a b" } };
    await expect(listener(req as never, res as never)).resolves.toBeUndefined();
    expect(status).toBe(400);
  });

  it("throws at construction time when the same (method, path) is registered twice", () => {
    // The table IS the allowlist, and `.find()` returns the first match, so a
    // duplicate would otherwise be silently shadowed rather than rejected.
    // Slice 4 adds ten routes across multiple arrays — exactly the situation
    // where a duplicate registered in the wrong one is otherwise invisible.
    const first: Route = { method: "GET", path: "/api/dup", handler: () => {} };
    const second: Route = { method: "GET", path: "/api/dup", handler: () => {} };
    expect(() => createRequestListener([first, second])).toThrow(/duplicate/i);
  });

  it("does not throw for the same path registered under different methods", () => {
    // Not every same-path repeat is a duplicate — GET and PUT on /api/key are
    // both legitimate and must keep working.
    const getRoute: Route = { method: "GET", path: "/api/key", handler: () => {} };
    const putRoute: Route = { method: "PUT", path: "/api/key", handler: () => {} };
    expect(() => createRequestListener([getRoute, putRoute])).not.toThrow();
  });

  it("terminates the response exactly once when a handler throws after sending headers", async () => {
    // Once writeHead has run, a 500 can no longer be sent (writeHead cannot
    // be called twice) — but the connection must still be closed, or the
    // client hangs until a socket/idle timeout with no terminating chunk.
    const leaky: Route = {
      method: "GET",
      path: "/api/leaky",
      handler: (_req, res) => {
        res.writeHead(200);
        throw new Error("db password is hunter2");
      },
    };
    const result = await call([leaky], "GET", "/api/leaky");
    expect(result.endCalls).toBe(1);
    expect(result.body).not.toContain("hunter2");
  });
});

describe("cookies", () => {
  it("parses a cookie header", () => {
    expect(parseCookies("sid=abc; theme=dark")).toEqual({ sid: "abc", theme: "dark" });
  });

  it("returns an empty object when there is no header", () => {
    expect(parseCookies(undefined)).toEqual({});
  });

  it("handles values containing '='", () => {
    // base64url has no '=', but base64 padding does, and a wrong split here
    // silently truncates a session id into an unusable one.
    expect(parseCookies("sid=ab=cd")).toEqual({ sid: "ab=cd" });
  });

  it("serializes with the security attributes the spec requires", () => {
    const cookie = serializeCookie("sid", "abc", { maxAgeSeconds: 60, secure: true });
    expect(cookie).toContain("sid=abc");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=60");
  });

  it("omits Secure when not serving over TLS, so local development works", () => {
    expect(serializeCookie("sid", "abc", { secure: false })).not.toContain("Secure");
  });
});

/** Fakes req as an async iterable of Buffers, the shape readJsonBody consumes. */
function fakeReqWithBody(chunks: Buffer[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

describe("readJsonBody", () => {
  it("parses a normal JSON body to the expected object", async () => {
    const req = fakeReqWithBody([Buffer.from('{"email":"a@example.com","password":"hunter2"}')]);
    await expect(readJsonBody(req as never)).resolves.toEqual({
      email: "a@example.com",
      password: "hunter2",
    });
  });

  it("returns {} for an empty body", async () => {
    const req = fakeReqWithBody([]);
    await expect(readJsonBody(req as never)).resolves.toEqual({});
  });

  it("rejects a body over 1 MB", async () => {
    // Genuinely over the bound, not near it: one 1.5 MB chunk. Assert the
    // specific message so this pins the size guard, not an incidental
    // JSON.parse failure on non-JSON filler bytes.
    const req = fakeReqWithBody([Buffer.alloc(1_500_000, "a")]);
    await expect(readJsonBody(req as never)).rejects.toThrow("body too large");
  });
});
