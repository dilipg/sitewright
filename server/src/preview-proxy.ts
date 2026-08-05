// server/src/preview-proxy.ts
/**
 * A raw byte-shuffling reverse proxy between the server's HTTP boundary and
 * a single preview child's Vite dev server (see `preview-pool.ts`). This
 * module deliberately knows nothing about projects, ownership, or the pool —
 * a caller resolves a port and a rewritten path (the child is served under a
 * Vite `base` of `/preview/<projectId>/`, so the caller has already stripped
 * that prefix before calling in); this module only forwards bytes.
 *
 * Two functions, two protocols: `proxyHttp` forwards a normal request/
 * response pair; `proxyUpgrade` forwards the WebSocket handshake Vite's HMR
 * depends on. Without the upgrade path, a client's HMR socket retries
 * forever and a regenerated section never appears without a manual reload —
 * which is the whole reason a live dev server is kept running per project
 * instead of a static build.
 *
 * Neither function may EVER throw, nor leave an unhandled 'error' event on
 * any stream it touches. Both are called from a request/upgrade listener:
 * slice 2 shipped exactly the async-listener half of this bug once already
 * — an uncaught throw inside an async request listener becomes a rejected
 * promise that `node:http` never awaits, so no response is written at all
 * and the connection hangs to the client's own timeout. The stream half is
 * worse: an 'error' event with no listener attached throws synchronously and
 * can crash the whole process, not just this one request. Every stream this
 * module touches (the inbound request/response, the outbound request/
 * response, and — for upgrades — both raw sockets) gets an 'error' listener
 * for exactly this reason.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { sendJson } from "./router.ts";

/**
 * The spec's own measurements: section regen ~90s, add-section ~84s, page
 * regen ~5 minutes, and an export's production build "several minutes". This
 * sits well above all of them, with margin, on purpose — a 504 does NOT stop
 * the subprocess doing the work underneath it. A premature timeout produces
 * a UI that reports failure while the work keeps running, a user who retries
 * on top of that, and — worst case — two page regenerations mutating one
 * project directory at the same time.
 */
export const PREVIEW_PROXY_TIMEOUT_MS = 15 * 60 * 1000;

/** `sendJson`, but safe to call from a path that must never throw: skips writing if the response is already spoken for. */
function safeSendJson(res: ServerResponse, status: number, payload: unknown): void {
  try {
    if (res.headersSent || res.writableEnded) return;
    sendJson(res, status, payload);
  } catch {
    // The client is already gone; there is nothing left to deliver this to.
  }
}

/** Ends the response with no body — used when headers are already on the wire and no status/body can be changed. */
function safeEnd(res: ServerResponse): void {
  try {
    if (!res.writableEnded) res.end();
  } catch {
    // Ditto.
  }
}

/**
 * Forwards one HTTP request/response pair to the preview child listening on
 * `port`, using `path` (already rewritten past the Vite `base` prefix) in
 * place of the inbound request's own URL.
 *
 * Resolves once the exchange is over — success, upstream error, or timeout —
 * and NEVER rejects: every exit path is funnelled through `settle()` below.
 */
export function proxyHttp(args: {
  req: IncomingMessage;
  res: ServerResponse;
  port: number;
  path: string;
}): Promise<void> {
  const { req, res, port, path } = args;

  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    // A response the client has already walked away from must not keep this
    // promise (or the upstream request) alive.
    res.on("error", () => {
      upstreamReq.destroy();
      settle();
    });

    // Definite-assignment (`!`): referenced above inside a listener that can
    // only ever run in a later microtask/event, by which point the
    // synchronous assignment just below has already completed — the same
    // pattern `preview-pool.ts` uses for `entry`.
    let upstreamReq!: ReturnType<typeof httpRequest>;
    try {
      upstreamReq = httpRequest({
        hostname: "localhost",
        port,
        path,
        method: req.method,
        // `host` rewritten to the upstream's own loopback address and port:
        // leaving the proxy's own Host header on the forwarded request makes
        // Vite's origin/host checks reject it outright.
        headers: { ...req.headers, host: `localhost:${port}` },
      });
    } catch (err) {
      safeSendJson(res, 502, { error: `could not construct upstream request: ${String(err)}` });
      settle();
      return;
    }

    // See the module comment: an unlistened 'error' event throws.
    upstreamReq.on("error", () => {
      // A dead child (nothing listening on `port`, connection refused,
      // reset mid-response, …) must become a 502, never a hung request —
      // this is exactly the shape a crashed preview process produces.
      if (!res.headersSent) {
        safeSendJson(res, 502, { error: "preview upstream is not reachable" });
      } else {
        safeEnd(res);
      }
      settle();
    });

    upstreamReq.setTimeout(PREVIEW_PROXY_TIMEOUT_MS, () => {
      upstreamReq.destroy();
      if (!res.headersSent) {
        safeSendJson(res, 504, { error: "preview upstream timed out" });
      } else {
        safeEnd(res);
      }
      settle();
    });

    upstreamReq.on("response", (upstreamRes) => {
      try {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      } catch {
        upstreamRes.destroy();
        settle();
        return;
      }
      upstreamRes.on("error", () => {
        safeEnd(res);
        settle();
      });
      res.on("close", settle);
      res.on("finish", settle);
      upstreamRes.pipe(res);
    });

    // The inbound client aborting mid-body must stop the upstream request
    // rather than leaving it open waiting for a body that will never finish.
    req.on("error", () => upstreamReq.destroy());

    req.pipe(upstreamReq);
  });
}

/**
 * Forwards one WebSocket upgrade handshake — and every raw byte afterwards,
 * both directions — to the preview child listening on `port`. Vite's HMR
 * client depends on this: without it the socket never completes its
 * handshake, the client retries forever, and a regenerated section never
 * shows up in preview without a manual reload.
 *
 * Never throws. There is no timeout here on purpose — an open WebSocket is
 * meant to sit idle for long stretches between HMR events, unlike a normal
 * request/response.
 */
export function proxyUpgrade(args: {
  req: IncomingMessage;
  socket: Duplex;
  head: Buffer;
  port: number;
  path: string;
}): void {
  const { req, socket, head, port, path } = args;

  // See the module comment: an unlistened 'error' event on the inbound
  // socket throws. This also catches the client vanishing before the
  // upstream even answers.
  socket.on("error", () => {
    upstreamReq.destroy();
  });

  // See the definite-assignment note in `proxyHttp` above — same pattern.
  let upstreamReq!: ReturnType<typeof httpRequest>;
  try {
    upstreamReq = httpRequest({
      hostname: "localhost",
      port,
      path,
      method: req.method,
      headers: { ...req.headers, host: `localhost:${port}` },
    });
  } catch {
    try { socket.destroy(); } catch { /* already gone */ }
    return;
  }

  upstreamReq.on("error", () => {
    try { socket.destroy(); } catch { /* already gone */ }
  });

  upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    upstreamSocket.on("error", () => {
      try { socket.destroy(); } catch { /* already gone */ }
    });
    // The mirror image: an abrupt client disconnect (RST/ECONNRESET, not a
    // graceful FIN) surfaces as 'error' on `socket`, not 'close' — and
    // node:http's server sockets are created with `allowHalfOpen: true`, so
    // a plain 'close' handler alone does not cover this path. Without this,
    // a client that vanishes uncleanly leaks the upstream half of the
    // socket exactly like a killed preview leaks the client half.
    socket.on("error", () => {
      try { upstreamSocket.destroy(); } catch { /* already gone */ }
    });

    try {
      // Node's HTTP client parses the upstream's raw handshake response into
      // `statusCode`/`headers` but does not hand back the raw bytes — so the
      // handshake line + headers sent on to the client socket are
      // reconstructed here, not copied verbatim. This is the same technique
      // node-http-proxy uses for the same reason.
      const statusLine = `HTTP/1.1 ${upstreamRes.statusCode ?? 101} ${upstreamRes.statusMessage ?? "Switching Protocols"}`;
      const headerLines = Object.entries(upstreamRes.headers).flatMap(([name, value]) => {
        if (value === undefined) return [];
        const values = Array.isArray(value) ? value : [value];
        return values.map((v) => `${name}: ${v}`);
      });
      socket.write([statusLine, ...headerLines, "", ""].join("\r\n"));
    } catch {
      try { socket.destroy(); } catch { /* already gone */ }
      try { upstreamSocket.destroy(); } catch { /* already gone */ }
      return;
    }

    // Bytes the upstream had already sent past its own handshake terminator
    // by the time the 'upgrade' event fired — must reach the client exactly
    // like everything piped afterwards.
    if (upstreamHead.length > 0) {
      try { socket.write(upstreamHead); } catch { /* client already gone */ }
    }
    // Bytes the client sent past ITS handshake terminator before the
    // upstream connection was even open.
    if (head.length > 0) {
      try { upstreamSocket.write(head); } catch { /* upstream already gone */ }
    }

    // A killed preview process must not leak the client's half of the
    // socket, and a client that disconnects must not leave the upstream
    // socket dangling — destroy one side the moment the other closes.
    socket.on("close", () => upstreamSocket.destroy());
    upstreamSocket.on("close", () => socket.destroy());

    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
  });

  upstreamReq.end();
}
