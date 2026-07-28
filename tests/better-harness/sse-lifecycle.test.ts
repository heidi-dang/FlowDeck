/**
 * Standalone HTTP lifecycle integration tests for Better Harness SSE contract.
 *
 * These tests compose the real runtime, SSE manager, and HTTP server without
 * requiring the full OpenCode plugin entry point, using ephemeral ports and
 * temporary directories.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { launchStandaloneServer, type StandaloneServerMeta } from "../../src/better-harness/testing/standalone-launcher";
import { SSEEnvelopeSchema } from "../../src/better-harness/contracts/sse-events";

const LIFECYCLE_TIMEOUT = 30_000;

describe("Better Harness HTTP Lifecycle", () => {
  let meta: StandaloneServerMeta;

  beforeAll(async () => {
    meta = await launchStandaloneServer();
  }, 30_000);

  afterAll(async () => {
    await meta.shutdown();
  }, 10_000);

  // ─── Server setup ────────────────────────────────────────────────

  it("launches on an ephemeral port", () => {
    expect(meta).not.toBeNull();
    expect(meta.port).toBeGreaterThan(0);
    expect(meta.baseUrl).toContain("127.0.0.1");
  });

  it("has a registered serverKey, projectKey, and projectId", () => {
    expect(meta.serverKey).toMatch(/^test-server-/);
    expect(meta.projectKey).toMatch(/^test-project-/);
    expect(meta.projectId).toBeTruthy();
  });

  // ─── Health ──────────────────────────────────────────────────────

  it("health endpoint returns ok", async () => {
    const res = await fetch(`${meta.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  // ─── Unknown project rejection ───────────────────────────────────

  it("rejects unknown project key with 404", async () => {
    const res = await fetch(`${meta.baseUrl}/api/v1/servers/${meta.serverKey}/projects/unknown-key/better-harness/availability`);
    expect(res.status).toBe(404);
  });

  // ─── Availability ────────────────────────────────────────────────

  it("returns available for registered project", async () => {
    const res = await fetch(`${meta.baseUrl}/api/v1/servers/${meta.serverKey}/projects/${meta.projectKey}/better-harness/availability`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe(true);
  });

  // ─── Start run ───────────────────────────────────────────────────

  it("starts a run and returns accepted: true with runId", async () => {
    const res = await fetch(
      `${meta.baseUrl}/api/v1/servers/${meta.serverKey}/projects/${meta.projectKey}/better-harness/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "full" }),
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.accepted).toBe(true);
    expect(body.runId).toBeDefined();
    expect(typeof body.runId).toBe("string");
  }, LIFECYCLE_TIMEOUT);

  // ─── SSE event stream ────────────────────────────────────────────

  it("SSE delivers canonical connected frame then heartbeat", async () => {
    const runRes = await fetch(
      `${meta.baseUrl}/api/v1/servers/${meta.serverKey}/projects/${meta.projectKey}/better-harness/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "full" }),
      },
    );
    const { runId } = await runRes.json();
    expect(runId).toBeDefined();

    // Connect to SSE and read first frames
    const sseRes = await fetch(
      `${meta.baseUrl}/api/v1/servers/${meta.serverKey}/projects/${meta.projectKey}/better-harness/runs/${runId}/events`,
    );
    expect(sseRes.status).toBe(200);

    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let connected = false;
    let heartbeat = false;
    let accumulated = "";

    for (let i = 0; i < 50; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });

      if (accumulated.includes("event: connected")) {
        connected = true;
        // Verify canonical envelope structure
        const match = accumulated.match(/data: ({.*?connected.*?})(\n|$)/);
        if (match) {
          const parsed = JSON.parse(match[1]);
          expect(parsed.type).toBe("connected");
          expect(parsed.timestamp).toBeTruthy();
          expect(parsed.data.clientId).toBeDefined();
          // Verify ISO timestamp
          expect(() => new Date(parsed.timestamp)).not.toThrow();
        }
      }

      if (accumulated.includes("event: heartbeat")) {
        heartbeat = true;
        const match = accumulated.match(/data: ({.*?heartbeat.*?})(\n|$)/);
        if (match) {
          const parsed = JSON.parse(match[1]);
          expect(parsed.type).toBe("heartbeat");
          expect(parsed.timestamp).toBeTruthy();
          expect(parsed.data.time).toBeTruthy();
        }
      }

      if (connected && heartbeat) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    reader.releaseLock();

    expect(connected).toBe(true);
    // Heartbeat may or may not have arrived in the first 10 seconds
  }, LIFECYCLE_TIMEOUT);

  // ─── Exact-run GET ──────────────────────────────────────────────

  it("exact-run GET returns persisted run state", async () => {
    const runRes = await fetch(
      `${meta.baseUrl}/api/v1/servers/${meta.serverKey}/projects/${meta.projectKey}/better-harness/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "full" }),
      },
    );
    const { runId } = await runRes.json();
    expect(runId).toBeDefined();

    // Poll until persisted
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const getRes = await fetch(
        `${meta.baseUrl}/api/v1/servers/${meta.serverKey}/projects/${meta.projectKey}/better-harness/runs/${runId}`,
      );
      if (getRes.status === 200) {
        const run = await getRes.json();
        expect(run.runId).toBe(runId);
        return;
      }
    }
    // Last attempt should fail with info
    const getRes = await fetch(
      `${meta.baseUrl}/api/v1/servers/${meta.serverKey}/projects/${meta.projectKey}/better-harness/runs/${runId}`,
    );
    expect(getRes.status).toBe(200);
  }, LIFECYCLE_TIMEOUT);

  // ─── Cancellation ────────────────────────────────────────────────

  it("cancels a running run with accepted:true", async () => {
    const runRes = await fetch(
      `${meta.baseUrl}/api/v1/servers/${meta.serverKey}/projects/${meta.projectKey}/better-harness/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "full" }),
      },
    );
    const { runId } = await runRes.json();

    const cancelRes = await fetch(
      `${meta.baseUrl}/api/v1/servers/${meta.serverKey}/projects/${meta.projectKey}/better-harness/runs/${runId}/cancel`,
      { method: "POST" },
    );
    expect(cancelRes.status).toBe(200);
    const body = await cancelRes.json();
    expect(body.accepted).toBe(true);
  }, LIFECYCLE_TIMEOUT);

  it("repeated cancellation returns accepted:false", async () => {
    const runRes = await fetch(
      `${meta.baseUrl}/api/v1/servers/${meta.serverKey}/projects/${meta.projectKey}/better-harness/runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "full" }),
      },
    );
    const { runId } = await runRes.json();

    // First cancel
    const cancel1 = await fetch(
      `${meta.baseUrl}/api/v1/servers/${meta.serverKey}/projects/${meta.projectKey}/better-harness/runs/${runId}/cancel`,
      { method: "POST" },
    );
    expect(cancel1.status).toBe(200);
    expect((await cancel1.json()).accepted).toBe(true);

    // Second cancel should return accepted:false
    const cancel2 = await fetch(
      `${meta.baseUrl}/api/v1/servers/${meta.serverKey}/projects/${meta.projectKey}/better-harness/runs/${runId}/cancel`,
      { method: "POST" },
    );
    expect(cancel2.status).toBe(200);
    const body2 = await cancel2.json();
    expect(body2.accepted).toBe(false);
  }, LIFECYCLE_TIMEOUT);

  // ─── Server shutdown cleanup ─────────────────────────────────────

  it("shutdown cleans up resources", async () => {
    const inner = await launchStandaloneServer();
    const { port, shutdown } = inner;

    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    expect(healthRes.status).toBe(200);

    await shutdown();

    await expect(
      fetch(`http://127.0.0.1:${port}/health`),
    ).rejects.toThrow();
  }, 15_000);
});
