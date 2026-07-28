import { describe, it, expect } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Re-import to get fresh module state
let mod: typeof import("../../src/better-harness/runtime/runtime-registry");
async function load() { mod = await import("../../src/better-harness/runtime/runtime-registry"); }

describe("Runtime Identity", () => {
  beforeAll(async () => { await load(); });

  it("canonicalize resolves absolute path", async () => {
    await load();
    const r = mod.canonicalize(tmpdir());
    expect(r).toBeTruthy();
    expect(r).not.toContain("..");
  });

  it("canonicalize rejects empty root", async () => {
    await load();
    expect(() => mod.canonicalize("")).toThrow();
  });

  it("canonicalize rejects missing root", async () => {
    await load();
    expect(() => mod.canonicalize("/nonexistent-path-xyz-123")).toThrow();
  });

  it("getServerKey returns a 32-hex-char string", async () => {
    await load();
    const k = mod.getServerKey();
    expect(k).toBeTruthy();
    expect(k.length).toBe(32);
    expect(/^[0-9a-f]+$/.test(k)).toBe(true);
  });

  it("getServerKey is consistent within one process", async () => {
    await load();
    expect(mod.getServerKey()).toBe(mod.getServerKey());
  });

  it("opaqueProjectId returns 32-hex-char stable hash", async () => {
    await load();
    const id1 = mod.opaqueProjectId("/tmp/proj1");
    expect(id1.length).toBe(32);
    expect(/^[0-9a-f]+$/.test(id1)).toBe(true);
    // Same input -> same output
    expect(mod.opaqueProjectId("/tmp/proj1")).toBe(id1);
  });

  it("opaqueProjectId differentiates different roots", async () => {
    await load();
    const id1 = mod.opaqueProjectId("/tmp/projA");
    const id2 = mod.opaqueProjectId("/tmp/projB");
    expect(id1).not.toBe(id2);
  });
});
