import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTransaction, fsAdapter } from "../scripts/config-transaction.mjs";

describe("Phase 30 — Transaction Fault Injection & Rollback Gates", () => {
  let testDir: string;
  let configPath: string;
  let manifestPath: string;
  let originalAdapter: any;

  beforeEach(() => {
    testDir = join(tmpdir(), `fd-trans-test-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });
    configPath = join(testDir, "opencode.json");
    manifestPath = join(testDir, ".flowdeck-manifest.json");

    // Save original adapter functions to restore after each test
    originalAdapter = { ...fsAdapter };
  });

  afterEach(() => {
    // Restore original adapter functions to prevent test pollution
    Object.assign(fsAdapter, originalAdapter);
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // Helper to check if file does not exist
  const assertAbsent = (path: string) => {
    expect(fs.existsSync(path)).toBe(false);
  };

  // 1. Config Read Failure
  it("fails closed when config read fails", async () => {
    fs.writeFileSync(configPath, '{"plugin":[]}', "utf-8");
    fsAdapter.readFileSync = (path: any, options: any) => {
      if (path === configPath) throw new Error("Injected config read error");
      return originalAdapter.readFileSync(path, options);
    };

    const result = await executeTransaction({
      configPath,
      edits: [{ path: ["plugin"], value: ["mutated"] }],
      manifestPath,
      manifest: { pluginRef: "test" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to read configuration file");
    expect(fs.readFileSync(configPath, "utf-8")).toBe('{"plugin":[]}');
    assertAbsent(manifestPath); // initially absent remains absent
  });

  // 2. Manifest Read Failure
  it("fails closed when manifest read fails", async () => {
    fs.writeFileSync(configPath, '{"plugin":[]}', "utf-8");
    fs.writeFileSync(manifestPath, '{"pluginRef":"old"}', "utf-8");
    fsAdapter.readFileSync = (path: any, options: any) => {
      if (path === manifestPath) throw new Error("Injected manifest read error");
      return originalAdapter.readFileSync(path, options);
    };

    const result = await executeTransaction({
      configPath,
      edits: [{ path: ["plugin"], value: ["mutated"] }],
      manifestPath,
      manifest: { pluginRef: "test" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to read install manifest");
    expect(fs.readFileSync(configPath, "utf-8")).toBe('{"plugin":[]}');
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe('{"pluginRef":"old"}');
  });

  // 3. Backup Creation Failure
  it("aborts transaction if backup creation fails", async () => {
    fs.writeFileSync(configPath, '{"plugin":[]}', "utf-8");
    fsAdapter.createBackup = () => {
      return null; // simulate backup failure
    };

    const result = await executeTransaction({
      configPath,
      edits: [{ path: ["plugin"], value: ["mutated"] }],
      manifestPath,
      manifest: { pluginRef: "test" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Backup failed");
    expect(fs.readFileSync(configPath, "utf-8")).toBe('{"plugin":[]}');
    assertAbsent(manifestPath);
  });

  // 4. Provisional Manifest Write Failure
  it("rolls back if provisional manifest write fails", async () => {
    const originalConfig = '{"plugin":[]}';
    fs.writeFileSync(configPath, originalConfig, "utf-8");
    fsAdapter.atomicWrite = (path: string, content: string) => {
      if (path === manifestPath) {
        throw new Error("Injected provisional write error");
      }
      return originalAdapter.atomicWrite(path, content);
    };

    const result = await executeTransaction({
      configPath,
      edits: [{ path: ["plugin"], value: ["mutated"] }],
      manifestPath,
      manifest: { pluginRef: "test" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to write provisional manifest");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(originalConfig);
    assertAbsent(manifestPath);
  });

  // 5. Config Atomic Write Failure
  it("rolls back (both config and manifest) if config atomic write fails", async () => {
    const originalConfig = '{"plugin":[]}';
    const originalManifest = '{"schemaVersion":2}';
    fs.writeFileSync(configPath, originalConfig, "utf-8");
    fs.writeFileSync(manifestPath, originalManifest, "utf-8");

    fsAdapter.atomicWrite = (path: string, content: string) => {
      if (path === configPath) {
        throw new Error("Injected config write error");
      }
      return originalAdapter.atomicWrite(path, content);
    };

    const result = await executeTransaction({
      configPath,
      edits: [{ path: ["plugin"], value: ["mutated"] }],
      manifestPath,
      manifest: { pluginRef: "test" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Config write failed — restored backup");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(originalConfig);
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe(originalManifest);
  });

  // 6. Manifest Finalization Failure
  it("rolls back (both config and manifest) if manifest finalization fails", async () => {
    const originalConfig = '{"plugin":[]}';
    const originalManifest = '{"schemaVersion":2}';
    fs.writeFileSync(configPath, originalConfig, "utf-8");
    fs.writeFileSync(manifestPath, originalManifest, "utf-8");

    let manifestWrites = 0;
    fsAdapter.atomicWrite = (path: string, content: string) => {
      if (path === manifestPath) {
        manifestWrites++;
        if (manifestWrites === 2) { // 2nd write is finalization
          throw new Error("Injected finalization error");
        }
      }
      return originalAdapter.atomicWrite(path, content);
    };

    const result = await executeTransaction({
      configPath,
      edits: [{ path: ["plugin"], value: ["mutated"] }],
      manifestPath,
      manifest: { pluginRef: "test" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Manifest finalization failed — full rollback");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(originalConfig);
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe(originalManifest);
  });

  // 7. Manifest Deletion Failure
  it("rolls back if manifest deletion fails", async () => {
    const originalConfig = '{"plugin":[]}';
    const originalManifest = '{"schemaVersion":2}';
    fs.writeFileSync(configPath, originalConfig, "utf-8");
    fs.writeFileSync(manifestPath, originalManifest, "utf-8");

    fsAdapter.unlinkSync = (path: string) => {
      if (path === manifestPath) {
        throw new Error("Injected unlink error");
      }
      return originalAdapter.unlinkSync(path);
    };

    const result = await executeTransaction({
      configPath,
      edits: [{ path: ["plugin"], value: ["mutated"] }],
      manifestPath,
      deleteManifest: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Manifest deletion failed — full rollback");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(originalConfig);
    expect(fs.readFileSync(manifestPath, "utf-8")).toBe(originalManifest);
  });

  // 8. Config Restoration Failure
  it("surfaces error when config restoration fails", async () => {
    const originalConfig = '{"plugin":[]}';
    fs.writeFileSync(configPath, originalConfig, "utf-8");

    let isRollingBack = false;
    fsAdapter.atomicWrite = (path: string, content: string) => {
      if (path === configPath) {
        if (!isRollingBack) {
          isRollingBack = true;
          throw new Error("Injected config write error");
        } else {
          throw new Error("Injected config restoration error");
        }
      }
      return originalAdapter.atomicWrite(path, content);
    };

    const result = await executeTransaction({
      configPath,
      edits: [{ path: ["plugin"], value: ["mutated"] }],
      manifestPath,
      manifest: { pluginRef: "test" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("config restoration failed: Injected config restoration error");
  });

  // 9. Manifest Restoration Failure
  it("surfaces error when manifest restoration fails", async () => {
    const originalConfig = '{"plugin":[]}';
    const originalManifest = '{"schemaVersion":2}';
    fs.writeFileSync(configPath, originalConfig, "utf-8");
    fs.writeFileSync(manifestPath, originalManifest, "utf-8");

    fsAdapter.atomicWrite = (path: string, content: string) => {
      if (path === configPath) {
        throw new Error("Injected config write error");
      }
      if (path === manifestPath) {
        // In restoration phase (since 1st write succeeded and we failed on config)
        if (content === originalManifest) {
          throw new Error("Injected manifest restoration error");
        }
      }
      return originalAdapter.atomicWrite(path, content);
    };

    const result = await executeTransaction({
      configPath,
      edits: [{ path: ["plugin"], value: ["mutated"] }],
      manifestPath,
      manifest: { pluginRef: "test" },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("manifest restoration failed: Injected manifest restoration error");
  });
});
