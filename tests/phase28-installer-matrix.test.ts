import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { executeTransaction } from "../scripts/config-transaction.mjs";

describe("Phase 28 — Local Installer Matrix & Complex Path Gates", () => {
  let tmpHome: string;
  let complexCheckout: string;
  let configDir: string;
  let configFile: string;
  let manifestFile: string;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `fd-matrix-test-${Math.random().toString(36).slice(2)}`);
    // Path containing spaces and Unicode
    complexCheckout = join(tmpHome, "sub folder", "flowdeck ✨ app");
    configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(complexCheckout, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    configFile = join(configDir, "opencode.json");
    manifestFile = join(configDir, ".flowdeck-manifest.json");
  });

  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("converts complex local path to file URL correctly", () => {
    const fileUrl = pathToFileURL(complexCheckout).href;
    expect(fileUrl).toContain("file://");
    // Verify fileURLToPath roundtrips correctly
    const restoredPath = fileURLToPath(fileUrl);
    expect(restoredPath).toBe(complexCheckout);
  });

  it("registers local checkout file URL in config and manifest", async () => {
    const pluginUrl = pathToFileURL(complexCheckout).href;
    const unrelatedUrl = "file:///usr/local/share/other-plugin";

    writeFileSync(configFile, JSON.stringify({ plugin: [unrelatedUrl], default_agent: null }), "utf-8");

    const result = await executeTransaction({
      configPath: configFile,
      edits: [
        { path: ["plugin"], value: [unrelatedUrl, pluginUrl] },
        { path: ["default_agent"], value: "heidi" },
      ],
      manifest: {
        schemaVersion: 2,
        pluginRef: pluginUrl,
        pluginAdded: true,
        installationMode: "local-repo",
        checkoutPath: complexCheckout,
      },
      manifestPath: manifestFile,
    });

    expect(result.ok).toBe(true);

    const cfg = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(cfg.plugin).toContain(pluginUrl);
    expect(cfg.plugin).toContain(unrelatedUrl);

    const manifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
    expect(manifest.checkoutPath).toBe(complexCheckout);
    expect(manifest.pluginRef).toBe(pluginUrl);
  });

  it("managed uninstall removes only owned file URL and preserves unrelated local plugin", async () => {
    const ownedUrl = pathToFileURL(complexCheckout).href;
    const unrelatedUrl = "file:///usr/local/share/unrelated-plugin";

    const initialConfig = JSON.stringify({ plugin: [unrelatedUrl, ownedUrl], default_agent: "heidi" });
    writeFileSync(configFile, initialConfig, "utf-8");

    const manifest = {
      schemaVersion: 2,
      pluginRef: ownedUrl,
      pluginAdded: true,
      defaultAgentAdded: true,
      previousDefaultAgent: null,
      installationMode: "local-repo",
      checkoutPath: complexCheckout,
    };
    writeFileSync(manifestFile, JSON.stringify(manifest), "utf-8");

    // Perform managed uninstall transaction
    const filteredPlugins = [unrelatedUrl];
    const uninstallResult = await executeTransaction({
      configPath: configFile,
      edits: [
        { path: ["plugin"], value: filteredPlugins },
        { path: ["default_agent"], value: undefined },
      ],
      manifest: {
        ...manifest,
        pluginAdded: false,
        uninstalledAt: new Date().toISOString(),
        installationMode: "uninstall",
      },
      manifestPath: manifestFile,
    });

    expect(uninstallResult.ok).toBe(true);

    const postConfig = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(postConfig.plugin).toEqual([unrelatedUrl]);
    expect(postConfig.default_agent).toBeUndefined();

    const postManifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
    expect(postManifest.pluginAdded).toBe(false);
    expect(postManifest.uninstalledAt).toBeDefined();
  });
});
