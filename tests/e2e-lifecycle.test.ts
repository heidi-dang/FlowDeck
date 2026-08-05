/**
 * Unit tests for the E2E lifecycle helpers — bounded server readiness, bounded
 * browser launch, guaranteed cleanup with persistent SSE connections, and
 * orphan-process detection. These cover the Windows hang classes the real E2E
 * suite guards against (see `tests/ui/browser-e2e.test.ts`).
 */

import { describe, it, expect } from "bun:test";
import type { ServerResponse } from "http";
import {
  startE2EServer,
  closeE2EAll,
  snapshotChromiumPids,
  assertNoOrphans,
  sleep,
  type SseManagerLike,
} from "./helpers/e2e-lifecycle";

function okHandler(_req: unknown, res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<html><body>ok</body></html>");
}

describe("E2E server readiness", () => {
  it("normal startup becomes ready and reports its port", async () => {
    const e2e = await startE2EServer(okHandler, { readinessTimeoutMs: 5000 });
    expect(e2e.port).toBeGreaterThan(0);
    await closeE2EAll({ server: e2e });
  });

  it("fails within the bound with the last readiness state when the handler never returns 200", async () => {
    const handler = (_req: unknown, res: ServerResponse) => {
      res.writeHead(500);
      res.end("boom");
    };
    const started = Date.now();
    await expect(
      startE2EServer(handler, { readinessTimeoutMs: 500, probePath: "/" }),
    ).rejects.toThrow(/not ready within 500ms/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("fails fast when the server exits before readiness", async () => {
    const handler = (_req: unknown, _res: ServerResponse, server: import("http").Server) => {
      // Kill the server on the first probe — readiness must fail immediately,
      // not hang for the full timeout.
      server.close();
    };
    const started = Date.now();
    await expect(
      startE2EServer(handler, { readinessTimeoutMs: 5000, probePath: "/" }),
    ).rejects.toThrow(/server closed before readiness/);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("E2E cleanup with persistent SSE connections", () => {
  function sseHandler(_req: unknown, res: ServerResponse) {
    // Persistent SSE-style connection: headers written, body left open.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(": connected\n\n");
  }

  it("closeE2EAll force-closes a server blocked by an open SSE connection", async () => {
    const e2e = await startE2EServer(sseHandler, { readinessTimeoutMs: 5000 });

    // Simulate a client holding a persistent SSE connection open.
    const { get } = await import("http");
    await new Promise<void>((resolve, reject) => {
      const req = get({ host: "127.0.0.1", port: e2e.port, path: "/events" }, (res) => {
        res.on("data", () => {});
        resolve();
      });
      req.on("error", reject);
    });
    await sleep(50);

    const report = await closeE2EAll({
      server: e2e,
      serverCloseTimeoutMs: 3000,
    });
    expect(report.serverClosed).toBe(true);
    await assertNoOrphans(snapshotChromiumPids(), e2e.port);
  });

  it("closeE2EAll handles a disposed SSE manager cleanly", async () => {
    const e2e = await startE2EServer(sseHandler, { readinessTimeoutMs: 5000 });
    const sseManager: SseManagerLike = { dispose: () => {} };
    const report = await closeE2EAll({
      server: e2e,
      sseManager,
      serverCloseTimeoutMs: 3000,
    });
    expect(report.serverClosed).toBe(true);
    expect(report.forceKilled).toBe(false);
  });
});

describe("Orphan detection", () => {
  it("snapshotChromiumPids returns a list (possibly empty)", () => {
    const pids = snapshotChromiumPids();
    expect(Array.isArray(pids)).toBe(true);
  });

  it("assertNoOrphans passes when nothing was spawned", async () => {
    const before = snapshotChromiumPids();
    await assertNoOrphans(before); // no port to check
  });
});
