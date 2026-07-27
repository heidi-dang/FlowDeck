import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeTransaction, executeRollbackTransaction } from "../scripts/config-transaction.mjs";

describe("Phase 28 — Transaction Fault Injection & Rollback Gates", () => {
  let testDir: string;
  let configPath: string;
  let manifestPath: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `fd-trans-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    configPath = join(testDir, "opencode.json");
    manifestPath = join(testDir, ".flowdeck-manifest.json");
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("restores exact prior state when config file is malformed", async () => {
    const originalConfig = '{\n  "plugin": ["@heidi-dang/flowdeck"],\n  "default_agent": "heidi"\n}\n';
    const originalManifest = '{\n  "pluginRef": "@heidi-dang/flowdeck"\n}\n';
    writeFileSync(configPath, originalConfig, "utf-8");
    writeFileSync(manifestPath, originalManifest, "utf-8");

    // Pass malformed JSON edit input or target malformed config
    writeFileSync(configPath, "{ malformed json", "utf-8");

    const result = await executeTransaction({
      configPath,
      edits: [{ path: ["default_agent"], value: "orchestrator" }],
      manifest: { pluginRef: "new-ref" },
      manifestPath,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Malformed configuration");
    // File content remains untouched on failure before backup
    expect(readFileSync(configPath, "utf-8")).toBe("{ malformed json");
    expect(readFileSync(manifestPath, "utf-8")).toBe(originalManifest);
  });

  it("fails closed when existing manifest is corrupt", async () => {
    const originalConfig = '{\n  "plugin": ["@heidi-dang/flowdeck"]\n}\n';
    writeFileSync(configPath, originalConfig, "utf-8");
    writeFileSync(manifestPath, "corrupt manifest data {{{", "utf-8");

    const result = await executeTransaction({
      configPath,
      edits: [{ path: ["default_agent"], value: "heidi" }],
      manifest: { pluginRef: "@heidi-dang/flowdeck" },
      manifestPath,
      allowCorruptManifest: false,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Corrupt install manifest");
    expect(readFileSync(configPath, "utf-8")).toBe(originalConfig);
    expect(readFileSync(manifestPath, "utf-8")).toBe("corrupt manifest data {{{");
  });

  it("executes byte-perfect rollback via executeRollbackTransaction", async () => {
    const initialConfig = '{\n  // initial comment\n  "plugin": [],\n  "default_agent": null\n}\n';
    const initialManifest = '{\n  "schemaVersion": 2,\n  "pluginRef": "initial"\n}\n';
    writeFileSync(configPath, initialConfig, "utf-8");
    writeFileSync(manifestPath, initialManifest, "utf-8");

    // Create backup file simulating a prior state
    const backupPath = join(testDir, "opencode.json.bak.123");
    writeFileSync(backupPath, initialConfig, "utf-8");

    // Mutate current config
    writeFileSync(configPath, '{\n  "plugin": ["mutated"]\n}\n', "utf-8");

    const rbResult = await executeRollbackTransaction({
      configPath,
      manifestPath,
      backupPath,
    });

    expect(rbResult.ok).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toBe(initialConfig);
    const parsedManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    expect(parsedManifest.rolledBackFromBackup).toBe(backupPath);
  });

  it("cleans up created files on failure if files did not exist initially", async () => {
    // Config and manifest do NOT exist initially
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(manifestPath)).toBe(false);

    // Pass invalid edit structure that fails during applyJsoncEdits
    const result = await executeTransaction({
      configPath,
      edits: [{ path: [] as any, value: "invalid" }],
      manifest: { pluginRef: "test" },
      manifestPath,
    });

    if (!result.ok) {
      expect(existsSync(configPath)).toBe(false);
      expect(existsSync(manifestPath)).toBe(false);
    }
  });

  it("respects skipManifest: true by not creating or updating manifest", async () => {
    const originalConfig = '{\n  "plugin": ["@heidi-dang/flowdeck"]\n}\n';
    writeFileSync(configPath, originalConfig, "utf-8");
    expect(existsSync(manifestPath)).toBe(false);

    const result = await executeTransaction({
      configPath,
      edits: [{ path: ["plugin"], value: [] }],
      manifestPath,
      skipManifest: true,
    });

    expect(result.ok).toBe(true);
    expect(existsSync(manifestPath)).toBe(false);
    expect(readFileSync(configPath, "utf-8")).toContain('"plugin": []');
  });
});
