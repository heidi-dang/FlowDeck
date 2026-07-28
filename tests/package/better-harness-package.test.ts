/**
 * Validates that the packed FlowDeck artifact exports correctly.
 * Run with: bun test ./tests/package/better-harness-package.test.ts
 */
import { describe, it, expect } from "bun:test";

describe("Package exports", () => {
  it("plugin entry default is a function", async () => {
    const m = await import("../../dist/plugin.js");
    expect(typeof m.default).toBe("function");
  });

  it("api subpath is importable", async () => {
    const m = await import("../../dist/api.js");
    expect(m.AGENT_NAMES).toBeDefined();
    expect(m.createAgent).toBeDefined();
    expect(m.resolveBetterHarnessConfig).toBeDefined();
  });

  it("resolveBetterHarnessConfig returns defaults", async () => {
    const m = await import("../../dist/api.js");
    const r = m.resolveBetterHarnessConfig({});
    expect(r.enabled).toBe(true);
    expect(r.bindHost).toBe("127.0.0.1");
    expect(r.port).toBe(0);
  });
});
