import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { tmpdir } from "os";
import { mkdirSync } from "fs";
import { join } from "path";

async function load() { return import("../../src/better-harness/runtime/runtime-registry"); }

describe("Runtime Lifecycle", () => {
  afterAll(async () => {
    const m = await load();
    m._resetForTesting();
  });

  it("concurrent startBh calls share one promise", async () => {
    const m = await load();
    m._resetForTesting();
    const root = join(tmpdir(), "bh-lifecycle-concurrent-" + Date.now());
    mkdirSync(root, { recursive: true });
    let callCount = 0;
    const p1 = m.startBh(root, async () => { callCount++; return { state: "running" as const, stop: async () => {}, serverKey: m.getServerKey(), projectKey: m.opaqueProjectId(root), canonicalRoot: m.canonicalize(root), startedAt: new Date().toISOString() }; });
    const p2 = m.startBh(root, async () => { callCount++; return { state: "running" as const, stop: async () => {}, serverKey: m.getServerKey(), projectKey: m.opaqueProjectId(root), canonicalRoot: m.canonicalize(root), startedAt: new Date().toISOString() }; });
    await Promise.all([p1, p2]);
    expect(callCount).toBe(1);
  });

  it("stopBh is idempotent", async () => {
    const m = await load();
    m._resetForTesting();
    const root = join(tmpdir(), "bh-lifecycle-s1-" + Date.now());
    mkdirSync(root, { recursive: true });
    let stopCount = 0;
    await m.startBh(root, async () => ({ state: "running" as const, stop: async () => { stopCount++; }, serverKey: m.getServerKey(), projectKey: m.opaqueProjectId(root), canonicalRoot: m.canonicalize(root), startedAt: new Date().toISOString() }));
    await m.stopBh(root);
    await m.stopBh(root);
    expect(stopCount).toBe(1);
  });

  it("validTransition allows legal transitions", async () => {
    const m = await load();
    expect(m.validTransition("starting", "running")).toBe(true);
    expect(m.validTransition("starting", "stopping")).toBe(true);
    expect(m.validTransition("starting", "failed")).toBe(true);
    expect(m.validTransition("running", "stopping")).toBe(true);
    expect(m.validTransition("stopping", "stopped")).toBe(true);
    expect(m.validTransition("stopped", "starting")).toBe(true);
    expect(m.validTransition("failed", "starting")).toBe(true);
  });

  it("validTransition rejects illegal transitions", async () => {
    const m = await load();
    expect(m.validTransition("running", "starting")).toBe(false);
    expect(m.validTransition("running", "failed")).toBe(false);
    expect(m.validTransition("stopped", "running")).toBe(false);
    expect(m.validTransition("failed", "running")).toBe(false);
  });
});
