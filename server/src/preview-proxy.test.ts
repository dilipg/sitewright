// server/src/preview-proxy.test.ts
/**
 * Every test here drives `proxyHttp`/`proxyUpgrade` against a REAL `node:http`
 * upstream server and a real proxy server of its own — no mocked sockets.
 * That is deliberate: this module's entire job is shuffling bytes between
 * two real TCP connections, and a mock would only ever prove that the mock
 * was configured correctly, not that the proxy behaves like a proxy.
 *
 * The proxy server in these tests plays the role task 4 will play for real:
 * it strips a `/preview/<id>` prefix before calling `proxyHttp`/
 * `proxyUpgrade`, so the tests can independently prove "the caller's
 * rewritten path is what reaches upstream" rather than "whatever the client
 * happened to request reaches upstream unchanged" (those would pass under a
 * broken implementation that just forwarded `req.url` and ignored `path`).
 */
import * as http from "node:http";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_PROXY_TIMEOUT_MS, proxyHttp, proxyUpgrade } from "./preview-proxy.ts";

let upstream: Server;
let upstreamPort: number;
let seen: Array<{ url: string; method: string; headers: Record<string, unknown>; body: string }>;
/**
 * Every socket the upstream server hands off via its 'upgrade' event, so
 * `afterEach` can destroy them directly. This is NOT optional cleanup
 * hygiene: `Server.prototype.closeAllConnections()` (and therefore
 * `close()`'s own wait condition) does not reach a socket once it has been
 * detached via 'upgrade' — confirmed empirically against plain node:http,
 * independent of anything in `preview-proxy.ts`. A test that ends a raw
 * upgraded socket "politely" (`.destroy()` with nothing outstanding sends a
 * plain FIN, not a reset — and node:http accepts connections with
 * `allowHalfOpen: true`) leaves that socket's write half open forever
 * unless something explicit closes it, and `upstream.close()` below would
 * then hang waiting for a connection that is never going to finish on its
 * own.
 */
let upstreamUpgradedSockets: Set<Duplex>;

beforeEach(async () => {
  seen = [];
  upstreamUpgradedSockets = new Set();
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        url: req.url ?? "", method: req.method ?? "",
        headers: req.headers as Record<string, unknown>,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.url === "/boom") { res.writeHead(500); res.end("upstream error"); return; }
      res.writeHead(200, { "Content-Type": "text/plain", "X-Upstream": "yes" });
      res.end("hello from upstream");
    });
  });
  // Registered once, here, rather than per-test: every upgrade test adds
  // its OWN 'upgrade' listener on top of this one to script the handshake,
  // and node:http calls every registered listener, in order.
  upstream.on("upgrade", (_req, socket) => {
    upstreamUpgradedSockets.add(socket);
    socket.on("close", () => upstreamUpgradedSockets.delete(socket));
  });
  upstream.listen(0);
  await once(upstream, "listening");
  upstreamPort = (upstream.address() as { port: number }).port;
});

afterEach(async () => {
  for (const socket of upstreamUpgradedSockets) socket.destroy();
  upstream.close();
  await once(upstream, "close");
});

/** Mirrors what a caller does before invoking either proxy function: strip the `/preview/<id>` base off the incoming URL. */
function rewritePath(url: string): string {
  const stripped = url.replace(/^\/preview\/[^/]+/, "");
  return stripped === "" ? "/" : stripped;
}

/**
 * The second real server the brief calls for: a thin stand-in for what task
 * 4 will wire up behind the ownership check — a plain `node:http` server
 * whose request/upgrade listeners just call the two functions under test
 * against a fixed upstream `port`. `close()` destroys every socket this
 * server's own 'upgrade' event handed off before closing — see the note on
 * `upstreamUpgradedSockets` above; the same Node behaviour applies here.
 */
function startProxyServer(targetPort: number): Promise<{ server: Server; origin: string; port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const upgradedSockets = new Set<Duplex>();
    const server = createServer((req, res) => {
      void proxyHttp({ req, res, port: targetPort, path: rewritePath(req.url ?? "/") });
    });
    server.on("upgrade", (req, socket, head) => {
      upgradedSockets.add(socket);
      socket.on("close", () => upgradedSockets.delete(socket));
      proxyUpgrade({ req, socket, head, port: targetPort, path: rewritePath(req.url ?? "/") });
    });
    const close = async (): Promise<void> => {
      for (const socket of upgradedSockets) socket.destroy();
      server.close();
      await once(server, "close");
    };
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({ server, origin: `http://127.0.0.1:${address.port}`, port: address.port, close });
    });
  });
}

describe("proxyHttp", () => {
  it("forwards a GET's status, headers, and body from upstream to the client", async () => {
    const { origin, close } = await startProxyServer(upstreamPort);
    try {
      const response = await fetch(`${origin}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-upstream")).toBe("yes");
      expect(await response.text()).toBe("hello from upstream");
    } finally {
      await close();
    }
  });

  it("forwards the caller's rewritten path to upstream, not the original request URL", async () => {
    const { origin, close } = await startProxyServer(upstreamPort);
    try {
      await fetch(`${origin}/preview/abc/src/main.tsx`);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.url).toBe("/src/main.tsx");
    } finally {
      await close();
    }
  });

  it("rewrites the Host header to the upstream's own loopback address and port", async () => {
    // Load-bearing per the brief's step 5: removing this rewrite left every
    // other test in this file green (the fixture upstream never checks its
    // own Host header), so this assertion is the ONLY thing standing
    // between a regression here and it going unnoticed. Vite's dev server
    // does check this header (origin/host protection) and would 403 a
    // request carrying the proxy's own Host instead.
    const { origin, close } = await startProxyServer(upstreamPort);
    try {
      await fetch(`${origin}/`);
      expect(seen[0]?.headers.host).toBe(`localhost:${upstreamPort}`);
    } finally {
      await close();
    }
  });

  it("forwards a POST body intact", async () => {
    const { origin, close } = await startProxyServer(upstreamPort);
    try {
      const payload = JSON.stringify({ hello: "world" });
      await fetch(`${origin}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: payload,
      });
      expect(seen[0]?.body).toBe(payload);
    } finally {
      await close();
    }
  });

  it("passes an upstream 500 through as 500, never converting it to 502", async () => {
    const { origin, close } = await startProxyServer(upstreamPort);
    try {
      const response = await fetch(`${origin}/boom`);
      expect(response.status).toBe(500);
      expect(await response.text()).toBe("upstream error");
    } finally {
      await close();
    }
  });

  it("answers 502 with a JSON error body, never a hang, when the upstream is not listening", async () => {
    // A port bound then immediately closed: guaranteed nothing is listening
    // there, which is exactly what a crashed preview child produces.
    const probe = createServer();
    probe.listen(0);
    await once(probe, "listening");
    const deadPort = (probe.address() as { port: number }).port;
    probe.close();
    await once(probe, "close");

    const { origin, close } = await startProxyServer(deadPort);
    try {
      const response = await fetch(`${origin}/`);
      expect(response.status).toBe(502);
      const body: unknown = await response.json();
      expect(body).toHaveProperty("error");
    } finally {
      await close();
    }
  });

  it("PREVIEW_PROXY_TIMEOUT_MS is at least 10 minutes, and is actually wired onto the upstream request", async () => {
    // The bare number on its own proves nothing about behaviour — it could
    // be declared and never used. Spying on the real ClientRequest
    // prototype (not replacing its behaviour: no mockImplementation, so the
    // real request still runs against the real upstream started above)
    // confirms `proxyHttp` actually calls `setTimeout` with this exact
    // value, not just that the constant holds a big number.
    expect(PREVIEW_PROXY_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000);

    const spy = vi.spyOn(http.ClientRequest.prototype, "setTimeout");
    const { origin, close } = await startProxyServer(upstreamPort);
    try {
      await fetch(`${origin}/`);
      expect(spy).toHaveBeenCalledWith(PREVIEW_PROXY_TIMEOUT_MS, expect.any(Function));
    } finally {
      spy.mockRestore();
      await close();
    }
  });
});

/** Accumulates 'data' chunks until the buffer contains `marker`, or rejects after `timeoutMs`. */
function readUntil(socket: import("node:net").Socket, marker: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      socket.off("data", onData);
      reject(new Error(`timed out waiting for ${JSON.stringify(marker)}; got so far: ${JSON.stringify(buffer)}`));
    }, timeoutMs);
    function onData(chunk: Buffer): void {
      buffer += chunk.toString("utf8");
      if (buffer.includes(marker)) {
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(buffer);
      }
    }
    socket.on("data", onData);
  });
}

/** Opens the handshake on a fresh raw socket to `port` and returns it once connected. */
async function openRawUpgradeSocket(port: number): Promise<import("node:net").Socket> {
  const client = connect(port, "127.0.0.1");
  await once(client, "connect");
  client.write(
    "GET /preview/abc/ws HTTP/1.1\r\n"
    + "Host: localhost\r\n"
    + "Connection: Upgrade\r\n"
    + "Upgrade: websocket\r\n"
    + "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
    + "Sec-WebSocket-Version: 13\r\n"
    + "\r\n",
  );
  return client;
}

describe("proxyUpgrade", () => {
  it("proxies a WebSocket handshake end-to-end, including a frame the upstream pushes right after it", async () => {
    // No `ws` dependency: the handshake is written by hand over a raw
    // `node:net` socket on the client side, and the upstream's own
    // `node:http` 'upgrade' event plays the server side — both ends are
    // real sockets, nothing here is mocked.
    upstream.on("upgrade", (_req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n"
        + "Upgrade: websocket\r\n"
        + "Connection: Upgrade\r\n"
        + "\r\n",
      );
      socket.write("hello-frame");
    });

    const { port, close } = await startProxyServer(upstreamPort);
    try {
      const client = await openRawUpgradeSocket(port);
      try {
        const response = await readUntil(client, "hello-frame");
        expect(response).toContain("101");
        expect(response).toContain("hello-frame");
      } finally {
        client.destroy();
      }
    } finally {
      await close();
    }
  });

  it("tears down the client-facing socket when the upstream side dies — a killed preview must not leak the client's half", async () => {
    // This is the direction the brief calls out by name: a killed preview
    // subprocess drops the upstream side of the socket abruptly. If
    // `proxyUpgrade` only piped bytes and never reacted to that, the
    // client-facing socket would sit open forever pointed at nothing.
    let upstreamSideSocket: Duplex | undefined;
    upstream.on("upgrade", (_req, socket) => {
      upstreamSideSocket = socket;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n"
        + "Upgrade: websocket\r\n"
        + "Connection: Upgrade\r\n"
        + "\r\n",
      );
    });

    const { port, close } = await startProxyServer(upstreamPort);
    try {
      const client = await openRawUpgradeSocket(port);
      try {
        // Wait for the 101 to land, so the upgrade has genuinely completed
        // before the upstream is killed.
        await readUntil(client, "101");

        expect(upstreamSideSocket).toBeDefined();
        const closed = once(client, "close");
        upstreamSideSocket?.destroy();

        await closed; // Would hang forever if proxyUpgrade did not react.
      } finally {
        client.destroy();
      }
    } finally {
      await close();
    }
  });
});
