// server/src/preview-proxy.ts
/**
 * A raw byte-shuffling reverse proxy between the server's HTTP boundary and
 * a single preview child's Vite dev server (see `preview-pool.ts`). This
 * module deliberately knows nothing about projects, ownership, or the pool —
 * a caller resolves a port and a `path` to forward; this module only
 * forwards bytes, whatever `path` it is given.
 *
 * The real caller (`preview-routes.ts`, `scripts/serve.ts`'s upgrade handler)
 * passes the request's ORIGINAL path, `/preview/<projectId>/...` prefix and
 * all — never a version with that prefix stripped off. An earlier version of
 * this comment claimed the opposite, and only a real Vite child behind a
 * real proxy proved it wrong (task 4's manual verification): the child is
 * spawned with `--base /preview/<projectId>/` (`preview-pool.ts`), and Vite's
 * dev server, given a non-root `base`, expects every incoming request to
 * already carry that prefix — a stripped request gets redirected right back
 * to it. Proxying that redirect through unexamined loops the client against
 * its own original URL forever.
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
import { USAGE_ID_HEADER } from "../../compiler/src/usage-log-path.ts";
import { sendJson } from "./router.ts";

/**
 * The headers to send upstream: `req.headers` verbatim (see the module
 * comment — hop-by-hop headers survive on purpose), except `host` (rewritten
 * to the upstream's own loopback address, same reasoning as before), and
 * `cookie`/`authorization`/`USAGE_ID_HEADER`, dropped rather than forwarded.
 * The child never needs `cookie` or `authorization` — it serves one
 * project's own static/dev-server assets, not anything session-aware — and
 * forwarding either hands the browser's session id (or a bearer credential)
 * to a subprocess running the project's own unvalidated `vite.config.ts` and
 * plugin chain. `USAGE_ID_HEADER` is dropped for a different reason: it
 * selects where a billable request's model-usage log gets written
 * (compiler/src/usage-log-path.ts), so a client-supplied value would choose
 * that path for a subprocess it does not own. A later caller re-adds the
 * server's OWN value deliberately (compiler-routes.ts) — what must never
 * happen is a client's value surviving the trip. Applied identically for
 * both protocols this module forwards (`proxyHttp`'s ordinary request/
 * response and `proxyUpgrade`'s WebSocket handshake): Vite's HMR upgrade
 * carries the same session cookie an ordinary request does.
 */
function upstreamHeaders(req: IncomingMessage, port: number): IncomingMessage["headers"] {
  const headers = { ...req.headers };
  delete headers.cookie;
  delete headers.authorization;
  delete headers[USAGE_ID_HEADER];
  headers.host = `localhost:${port}`;
  return headers;
}

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
 * `port`, sending `path` in place of the inbound request's own URL.
 *
 * `path` is the caller's business, but note what the caller actually passes
 * (preview-routes.ts, preview-upgrade.ts): the request's ORIGINAL `req.url`,
 * `/preview/<projectId>/` prefix and query string intact — NOT a path
 * rewritten past the Vite `base` prefix, which is what this comment claimed
 * before task 4's manual verification disproved it. The child is spawned with
 * a matching `--base`, so Vite expects the prefix present; strip it and Vite
 * redirects to the very prefix just removed, looping the client against its
 * own original URL.
 *
 * Resolves once the exchange is over — success, upstream error, or timeout —
 * and NEVER rejects: every exit path is funnelled through `settle()` below.
 *
 * Resolves with `{ completed }`, not bare `void` — added for FIX 3 (a
 * whole-branch review) and reworked for residual 1 (a later one). FIX 3's
 * problem: `PREVIEW_PROXY_TIMEOUT_MS` and an unreachable upstream can both
 * resolve this promise WITHOUT ever genuinely relaying an upstream response,
 * while the orchestrator subprocess behind `port` may still be running and
 * still appending to its usage log. A caller that treats "this promise
 * settled" as "the run is over" (`preview-forward.ts` used to) ingests that
 * log while it is still partial, then deletes it — every line the
 * subprocess writes afterward lands in a file nobody will ever read again.
 *
 * FIX 3 originally treated a CLIENT ABORT the same way — settling early,
 * `completed: false` — which just relocated the same bug: the compiler
 * child has no abort listener of its own (`uv run python` runs a
 * regeneration or export to completion regardless of whether anyone is
 * still waiting on the HTTP response), so a caller gating `pool.release()`/
 * `releaseBillableSlot()` on this promise (see preview-forward.ts) would
 * free them while the run was still genuinely going — letting the idle
 * reaper SIGTERM a paid job, and letting the same user start more concurrent
 * billable work than the 429 bound is supposed to allow. Residual 1's fix:
 * a client abort (`res` emitting `close` or `error`) no longer settles this
 * promise or touches `upstreamReq` at all — see `clientLeft` below. The
 * upstream keeps running exactly as if the client were still there; once its
 * response arrives (or, if it already had, once the drain finishes), the
 * bytes are discarded instead of written to the now-gone `res`, and only
 * THEN does this promise settle, with `completed: true` — because from the
 * child's own perspective, that run is genuinely done.
 *
 * `completed` is `true` in exactly the shapes below that represent the
 * upstream genuinely finishing, regardless of whether a live client ever
 * received any of it: the upstream response fully flushing to `res` in the
 * ordinary case (`res`'s `finish` event), or — once the client is known
 * gone — the upstream response fully draining on its own (`clientLeft`, or
 * the `clientGone` branch inside the `"response"` handler). It stays
 * `false` for every path where the upstream itself never finished: an abort
 * before the upstream ever answered (still running when this promise
 * settles — see above, nothing here waits on it), an upstream error, a dead
 * upstream (502), a `writeHead` throw, or `PREVIEW_PROXY_TIMEOUT_MS`. That
 * last one is the one case that still actively tears the upstream down: 15
 * minutes in, the child really is stuck, there is no more "let it keep
 * running" left to offer, and that loss stays accepted (see
 * `PREVIEW_PROXY_TIMEOUT_MS`'s own comment). Note this means `completed`
 * does NOT mean "settled" any more than it did before residual 1 — several
 * `false` paths also write a complete, well-formed error response of their
 * own (a small 502/504 JSON body via `safeSendJson`), and a plain
 * `res.writableFinished` check right after one of those reads back `true`
 * regardless (confirmed empirically — Node marks a small, unbuffered write
 * finished before this function's own next statement runs), which is
 * exactly the false positive this dedicated signal exists to avoid. The
 * only thing it is FOR is deciding whether it is safe to ingest-and-delete
 * the usage log.
 */
export function proxyHttp(args: {
  req: IncomingMessage;
  res: ServerResponse;
  port: number;
  path: string;
  /**
   * Extra headers applied AFTER `upstreamHeaders`' own strip — so a value set
   * here always reaches the upstream, regardless of what the inbound request
   * carried (a client's own copy of the same header name is already deleted
   * by that point, never merely overwritten by something that could race
   * it). The only caller today (`compiler-routes.ts`, via
   * `preview-forward.ts`) uses this to set the server's own, freshly
   * generated `x-webgen-usage-id` on a billable request — never the
   * client's, which `upstreamHeaders` deletes unconditionally before this is
   * even applied.
   */
  setHeaders?: Record<string, string> | undefined;
}): Promise<{ completed: boolean }> {
  const { req, res, port, path, setHeaders } = args;

  return new Promise<{ completed: boolean }>((resolve) => {
    let settled = false;
    // Flipped to `true` in exactly the places described in the function
    // comment, and read at whichever `settle()` call actually wins.
    let completed = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve({ completed });
    };

    // True once the client is known to be gone (`res` emitted `close` or
    // `error`, whichever fires first) — recorded, never acted on
    // destructively, per the function comment. `upstreamRes`, once the
    // upstream has answered, lets `clientLeft` (a disconnect arriving mid-
    // pipe) and the `"response"` handler (a disconnect arriving before the
    // upstream answered) redirect to the same "drain, don't write" behaviour
    // regardless of which order the two events happen in.
    let clientGone = false;
    let upstreamRes: IncomingMessage | undefined;

    /**
     * Shared by `res`'s `"close"` and `"error"` listeners below. Never
     * touches `upstreamReq`/`upstreamRes` destructively and never settles —
     * the upstream keeps running exactly as if the client were still there.
     * If no response has arrived yet, there is nothing to do: the
     * `"response"` handler below checks `clientGone` itself and starts
     * draining from the first byte once one does arrive. If a response was
     * already mid-pipe to `res`, `res` will never legitimately emit
     * `"finish"` now (nothing will ever finish writing to it again), so
     * completion is re-anchored to the upstream response itself.
     */
    const clientLeft = (): void => {
      if (settled || clientGone) return;
      clientGone = true;
      if (upstreamRes === undefined) return;
      upstreamRes.unpipe(res);
      if (upstreamRes.complete) {
        // The upstream had already fully arrived before the client left —
        // it just hadn't all been flushed out over the (now-dead) client
        // socket yet. From the child's own perspective this run is done.
        completed = true;
        settle();
        return;
      }
      upstreamRes.resume();
      upstreamRes.once("end", () => {
        completed = true;
        settle();
      });
    };

    // A response the client has already walked away from must not keep this
    // promise alive forever (see `PREVIEW_PROXY_TIMEOUT_MS` below for the
    // bound), but per the function comment it must not tear the upstream
    // down either.
    res.on("error", clientLeft);
    // The far more common shape of "client walked away," per an empirical
    // check against a real aborted request: a client disconnecting BEFORE
    // anything has been written back fires 'close' on `res`, not 'error'.
    res.on("close", clientLeft);

    // Definite-assignment (`!`): referenced above inside a listener that can
    // only ever run in a later microtask/event, by which point the
    // synchronous assignment just below has already completed — the same
    // pattern `preview-pool.ts` uses for `entry`.
    let upstreamReq!: ReturnType<typeof httpRequest>;
    try {
      upstreamReq = httpRequest({
        // A literal IP, not the string "localhost": Node's resolution of
        // that bare hostname is platform/DNS-configuration dependent, and on
        // at least one real Windows machine it resolves to the IPv6 loopback
        // (::1) only — which does not match the IPv4 loopback address
        // compiler/src/preview.ts deliberately binds Vite to (see that
        // file's comment; found via this exact module's first live run,
        // task 4's manual verification). Connecting by IP number removes the
        // ambiguity. The `Host` HEADER below stays "localhost" on purpose —
        // that is a different, independent check (Vite's allowedHosts, which
        // permits localhost/127.0.0.1/[::1] regardless of bind address), not
        // the TCP connection target this option controls.
        hostname: "127.0.0.1",
        port,
        path,
        method: req.method,
        // See `upstreamHeaders`: verbatim except `host` (rewritten — leaving
        // the proxy's own Host header makes Vite's origin/host checks reject
        // it outright) and `cookie`/`authorization` (dropped — the child
        // never needs either, and forwarding hands it a session id or bearer
        // credential it has no business seeing). Otherwise deliberately
        // includes hop-by-hop headers (Connection, Transfer-Encoding,
        // Upgrade, …) that RFC 7230 says a proxy should strip: this hop goes
        // straight to the one Vite dev server this proxy exists to reach
        // over loopback, never through a further proxy hop where that would
        // actually matter.
        // `setHeaders` is spread LAST, after the strip above already ran —
        // see this function's own arg doc for why the ordering is the whole
        // point.
        headers: { ...upstreamHeaders(req, port), ...setHeaders },
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

    upstreamReq.on("response", (incoming) => {
      upstreamRes = incoming;

      if (clientGone) {
        // The client left before the upstream ever answered — `clientLeft`
        // above already ran and found no `upstreamRes` to drain yet. Drain
        // this one from the first byte so the child's own handler completes
        // and backpressure on this end never stalls it, but never attempt to
        // write to `res` — it is exactly as gone as it was a moment ago.
        incoming.on("error", () => settle());
        incoming.on("end", () => {
          completed = true;
          settle();
        });
        incoming.resume();
        return;
      }

      try {
        res.writeHead(incoming.statusCode ?? 502, incoming.headers);
      } catch (err) {
        // `headersSent` is still false here — writeHead threw before
        // committing anything — so a 502 is still deliverable. Hard to
        // trigger against a real Vite (Node's own HTTP parser already
        // rejects header syntax Node itself would refuse to WRITE, which
        // surfaces as 'error' on `upstreamReq`, already handled above), but
        // cheap defence-in-depth against whatever header shape does slip
        // through parsing yet still fail `writeHead`.
        incoming.destroy();
        safeSendJson(res, 502, { error: `could not relay upstream response: ${String(err)}` });
        settle();
        return;
      }
      incoming.on("error", () => {
        safeEnd(res);
        settle();
      });
      // Deliberately NOT also listening for `res`'s `"close"` here: that is
      // `clientLeft`'s job now (registered once, at the top, covering both
      // "before" and "during" a response) — a second listener settling
      // directly would race `clientLeft`'s own drain-then-settle and could
      // report `completed: false` for an exchange that was, a moment later,
      // going to finish normally.
      res.on("finish", () => {
        completed = true;
        settle();
      });
      incoming.pipe(res);
    });

    // The inbound client aborting mid-body must stop the upstream request
    // rather than leaving it open waiting for a body that will never finish.
    // Unlike a client disconnecting while waiting on the RESPONSE (handled
    // above by `clientLeft`, which deliberately does NOT destroy anything),
    // an incomplete REQUEST body means the upstream never received a
    // complete request to begin with — there is no orchestrator run already
    // under way to let finish, so there is nothing to preserve by leaving
    // this side open.
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

  // True once the fate of the HANDSHAKE ATTEMPT itself has been decided —
  // successfully upgraded, declined with an ordinary HTTP response, errored,
  // or abandoned because the client vanished first. Guards the handlers
  // below from acting twice on the same outcome (e.g. a client 'close'
  // arriving the same tick as an upstream 'error'), and — once a successful
  // upgrade below hands off to the bidirectional relay, which owns
  // `upstreamSocket` from that point on — turns the pre-handshake handlers
  // registered here into no-ops instead of reaching for a socket that relay
  // already owns. There is no equivalent flag needed once `settled` is set
  // via a successful upgrade: the relay's own close/error handlers (inside
  // the "upgrade" callback below) take over from there, unchanged.
  let settled = false;

  // See the definite-assignment note in `proxyHttp` above — same pattern.
  let upstreamReq!: ReturnType<typeof httpRequest>;

  // Pre-handshake only: the client disconnecting before the upstream has
  // resolved the handshake must not leave that upstream request open
  // indefinitely. There is deliberately no timeout on this path (see the
  // function comment), so without this an abandoned handshake attempt — a
  // closed tab, a navigation away, a retry — would hang forever rather than
  // for a bounded 15 minutes like `proxyHttp`. Three distinct events cover
  // three distinct ways a client goes away, confirmed empirically rather
  // than assumed: an abrupt reset fires 'error'; a graceful disconnect with
  // something already written back (mirrors `proxyHttp`'s `res`) fires
  // 'close'; but `socket` here is a bare `net.Duplex`, not an
  // `http.ServerResponse` — and node:http accepts connections with
  // `allowHalfOpen: true`, so a plain graceful FIN with NOTHING written
  // back yet (the common case: the handshake hasn't resolved) fires only
  // 'end', never 'close', because nothing on this side has completed the
  // other half of the close. Missing 'end' here left this exact case
  // hanging in testing — the client had disconnected, but neither 'close'
  // nor 'error' ever fired.
  socket.on("error", () => {
    if (settled) return;
    settled = true;
    upstreamReq.destroy();
  });
  socket.on("close", () => {
    if (settled) return;
    settled = true;
    upstreamReq.destroy();
  });
  socket.on("end", () => {
    if (settled) return;
    settled = true;
    upstreamReq.destroy();
    try { socket.destroy(); } catch { /* already gone */ }
  });

  try {
    upstreamReq = httpRequest({
      // See the matching comment in `proxyHttp`: a literal IP, not the
      // string "localhost", because Node's resolution of that hostname is
      // platform-dependent and does not reliably match the IPv4 loopback
      // address Vite is bound to.
      hostname: "127.0.0.1",
      port,
      path,
      method: req.method,
      // See `upstreamHeaders` / the matching comment in `proxyHttp`: hop-by-
      // hop headers are forwarded verbatim on purpose, same reasoning;
      // `cookie`/`authorization` are dropped, same reasoning too.
      headers: upstreamHeaders(req, port),
    });
  } catch {
    if (settled) return;
    settled = true;
    try { socket.destroy(); } catch { /* already gone */ }
    return;
  }

  upstreamReq.on("error", () => {
    if (settled) return;
    settled = true;
    try { socket.destroy(); } catch { /* already gone */ }
  });

  // The upstream declining the handshake with an ORDINARY HTTP response
  // instead of 101 — exactly how `ws` (which Vite's dev server uses)
  // rejects a bad handshake: a failed origin/host check, a path mismatch,
  // or the dev server not yet fully up. Node fires 'response' here, not
  // 'upgrade', for that case. Without this handler the client socket
  // received zero bytes and was never destroyed — hanging indefinitely,
  // since (as above) this path has no timeout by design.
  upstreamReq.on("response", (upstreamRes) => {
    if (settled) { upstreamRes.resume(); return; }
    settled = true;
    try {
      // Same reconstruction technique as the successful-upgrade path below:
      // relay the refusal as a raw HTTP response on the client socket.
      const statusLine = `HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? ""}`;
      const headerLines = Object.entries(upstreamRes.headers).flatMap(([name, value]) => {
        if (value === undefined) return [];
        const values = Array.isArray(value) ? value : [value];
        return values.map((v) => `${name}: ${v}`);
      });
      socket.write([statusLine, ...headerLines, "", ""].join("\r\n"));
    } catch {
      try { socket.destroy(); } catch { /* already gone */ }
      upstreamRes.resume();
      return;
    }
    upstreamRes.on("error", () => {
      try { socket.destroy(); } catch { /* already gone */ }
    });
    // Drains whatever body the refusal carries onto the client socket, then
    // closes it the moment the body ends — `pipe`'s default behaviour ends
    // the destination when the source ends, which is exactly "relay the
    // body, then end" for a plain Duplex target.
    upstreamRes.pipe(socket);
    // `pipe`'s "end the destination" above only ends socket's WRITE half
    // (a plain `.end()`, i.e. a FIN) — and by the time this fires, `settled`
    // is already `true`, so `socket`'s own "close"/"end" handlers (this
    // module doesn't register any on the pre-handshake path, but a caller
    // might, and node:http's server sockets accept `allowHalfOpen: true`)
    // have nothing here forcing the READ half closed too. That happens to be
    // correct for `ws` (Vite's own WebSocket implementation), which sends
    // `Connection: close` on a decline and destroys its end right after —
    // the client's FIN back is enough to fully close things — but it is
    // NOT correct for a decline from anything that doesn't self-destruct the
    // same way, and this path has no timeout (see the function comment) to
    // fall back on. Destroying outright once the body is fully relayed closes
    // both halves unconditionally, regardless of what the upstream does next.
    upstreamRes.on("end", () => {
      try { socket.destroy(); } catch { /* already gone */ }
    });
  });

  upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    // A late upgrade racing an already-decided outcome (the client vanished
    // while the upstream was still deciding): don't hand off to the relay
    // below for a client socket that is already gone, just drop the
    // now-pointless upstream socket.
    if (settled) { upstreamSocket.destroy(); return; }
    settled = true;

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
