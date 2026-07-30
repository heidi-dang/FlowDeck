import { describe, it, expect, afterAll } from "bun:test";
import { tmpdir } from "os";
import { mkdirSync } from "fs";
import { join } from "path";

async function load() { return import("../../src/better-harness/runtime/runtime-registry"); }

describe("Discovery", () => {
  afterAll(async () => {
    const m = await load();
    m._resetForTesting();
  });

  it("unknown project returns stopped state", async () => {
    const m = await load();
    const d = m.getDiscovery("sk", "pk");
    expect(d.available).toBe(false);
    expect(d.state).toBe("unknown");
  });

  it("authRequired true when passed true", async () => {
    const m = await load();
    const d = m.getDiscovery("sk", "pk", undefined, true);
    expect(d.authRequired).toBe(true);
  });

  it("authRequired false when passed false", async () => {
    const m = await load();
    const d = m.getDiscovery("sk", "pk", undefined, false);
    expect(d.authRequired).toBe(false);
  });

  it("running state returns available true", async () => {
    const m = await load();
    m._resetForTesting();
    const root = join(tmpdir(), "bh-disc-test-" + Date.now());
    mkdirSync(root, { recursive: true });
    await m.startBh(root, async () => ({
      state: "running" as const,
      stop: async () => {},
      serverKey: m.getServerKey(),
      projectKey: m.opaqueProjectId(root),
      canonicalRoot: m.canonicalize(root),
      startedAt: new Date().toISOString(),
    }));
    const key = m.getServerKey();
    const pk = m.opaqueProjectId(root);
    const d = m.getDiscovery(key, pk, m.canonicalize(root));
    expect(d.available).toBe(true);
    expect(d.state).toBe("running");
    expect(d.serverKey).toBe(key);
    expect(d.projectKey).toBe(pk);
  });

  it("contract and schema version are constants", async () => {
    const m = await load();
    expect(m.BH_CONTRACT_VERSION).toBe("1.0.0");
    expect(m.BH_SCHEMA_VERSION).toBe(1);
  });
});
