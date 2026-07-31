import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

import { safeParseConfig } from "../scripts/config-mutator.mjs";

const CLI_PATH = join(process.cwd(), "bin", "flowdeck.js");

function runCli(args: string[], env: Record<string, string>, cwd?: string): { code: number; stdout: string; stderr: string } {
  try {
    const nodePath = join(process.cwd(), "node_modules");
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, NODE_PATH: nodePath, FLOWDECK_BUN_BIN: (process as any).execPath, ...env },
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

describe("Phase 28 — CLI Behavioural & Ownership Integration Gates", () => {
  let tmpHome: string;
  let configDir: string;
  let configFile: string;
  let manifestFile: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `fd-cli-test-${Math.random().toString(36).slice(2)}`);
    configDir = join(tmpHome, ".config", "opencode");
    mkdirSync(configDir, { recursive: true });
    configFile = join(configDir, "opencode.json");
    manifestFile = join(configDir, ".flowdeck-manifest.json");
    env = { HOME: tmpHome, OPENCODE_CONFIG_DIR: configDir };
  });

  afterEach(() => {
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("flowdeck --help exits 0 and prints usage", () => {
    const res = runCli(["--help"], env);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("FlowDeck");
    expect(res.stdout).toContain("Usage:");
  });

  it("flowdeck install creates config and manifest transactionally preserving comments", () => {
    const initialConfig = '{\n  // custom comment\n  "plugin": [],\n  "default_agent": null\n}\n';
    writeFileSync(configFile, initialConfig, "utf-8");

    const res = runCli(["install"], env);
    expect(res.code).toBe(0);

    const updatedConfig = readFileSync(configFile, "utf-8");
    expect(updatedConfig).toContain("// custom comment");
    expect(updatedConfig).toContain('"@heidi-dang/flowdeck"');
    expect(updatedConfig).toContain('"default_agent": "heidi"');

    expect(existsSync(manifestFile)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
    expect(manifest.pluginRef).toBe("@heidi-dang/flowdeck");
    expect(manifest.pluginAdded).toBe(true);
    expect(manifest.defaultAgentAdded).toBe(true);
  });

  it("flowdeck install --project installs into project directory config", () => {
    const projectDir = join(tmpHome, "my-project");
    const projConfigDir = join(projectDir, ".opencode");
    mkdirSync(projConfigDir, { recursive: true });
    const projConfigFile = join(projConfigDir, "opencode.json");
    writeFileSync(projConfigFile, '{\n  "plugin": []\n}\n', "utf-8");

    const res = runCli(["install", "--project"], { ...env, OPENCODE_CONFIG_DIR: projConfigDir }, projectDir);
    expect(res.code).toBe(0);

    const updatedConfig = readFileSync(projConfigFile, "utf-8");
    expect(updatedConfig).toContain('"@heidi-dang/flowdeck"');
  });

  it("flowdeck install --local-repo registers file:// checkout URL", () => {
    const res = runCli(["install", "--local-repo"], env);
    expect(res.code).toBe(0);

    const manifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
    expect(manifest.installationMode).toBe("local-repo");
    expect(manifest.pluginRef).toContain("file://");
  });

  it("flowdeck migrate updates upstream reference and exits 0", () => {
    const upstreamConfig = '{\n  "plugin": ["@dv.nghiem/flowdeck"],\n  "default_agent": "orchestrator"\n}\n';
    writeFileSync(configFile, upstreamConfig, "utf-8");

    const res = runCli(["migrate"], env);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("migration succeeded");

    const updatedConfig = readFileSync(configFile, "utf-8");
    expect(updatedConfig).toContain('"@heidi-dang/flowdeck"');
    expect(updatedConfig).not.toContain('"@dv.nghiem/flowdeck"');
  });

  it("flowdeck migrate fails with non-zero exit when config is malformed", () => {
    writeFileSync(configFile, "{ malformed json {{{", "utf-8");

    const res = runCli(["migrate"], env);
    expect(res.code).not.toBe(0);
    expect(res.stdout).toContain("Configuration is malformed");
    expect(readFileSync(configFile, "utf-8")).toBe("{ malformed json {{{");
  });

  it("flowdeck rollback restores from backup created during transaction with byte-perfect comparison", () => {
    // Write initial config with specific spacing and comments to verify byte-perfect comparison
    const originalConfig = '{\n  // initial comment\n  "plugin": ["old-plugin"],\n  "default_agent": null\n}\n';
    writeFileSync(configFile, originalConfig, "utf-8");
    runCli(["install"], env);

    // Ensure manifest is created
    expect(existsSync(manifestFile)).toBe(true);

    // Get list of backup files created and verify pre-rollback backup contents
    const files = readdirSync(configDir);
    const backupFile = files.find(f => f.includes(".bak"));
    expect(backupFile).toBeDefined();

    const backupContent = readFileSync(join(configDir, backupFile!), "utf-8");
    expect(backupContent).toBe(originalConfig); // Pre-rollback backup verification

    const res = runCli(["rollback"], env);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Rolled back");

    // Exact config bytes restored
    expect(readFileSync(configFile, "utf-8")).toBe(originalConfig); // Rollback byte comparison

    // Manifest is NOT removed, but marked as rolled back
    expect(existsSync(manifestFile)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
    expect(manifest.rolledBackAt).toBeDefined();
    expect(manifest.rolledBackFromBackup).toBe(join(configDir, backupFile!));
  });

  it("flowdeck install failure during config write rolls back both config and manifest", () => {
    const originalConfig = '{\n  // important comment\n  "plugin": ["existing-plugin"]\n}\n';
    writeFileSync(configFile, originalConfig, "utf-8");
    expect(existsSync(manifestFile)).toBe(false);

    // Run install, forcing failure at config_write stage
    const res = runCli(["install"], { ...env, FLOWDECK_FAIL_AT_STAGE: "config_write" });
    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toContain("Config write failed");

    // Config must remain byte-for-byte identical
    expect(readFileSync(configFile, "utf-8")).toBe(originalConfig);
    // Manifest must remain absent
    expect(existsSync(manifestFile)).toBe(false);
  });

  it("flowdeck install failure during manifest finalization rolls back both config and manifest", () => {
    const originalConfig = '{\n  // important comment\n  "plugin": ["existing-plugin"]\n}\n';
    writeFileSync(configFile, originalConfig, "utf-8");
    expect(existsSync(manifestFile)).toBe(false);

    // Run install, forcing failure at manifest_finalize stage
    const res = runCli(["install"], { ...env, FLOWDECK_FAIL_AT_STAGE: "manifest_finalize" });
    expect(res.code).not.toBe(0);
    expect(res.stderr + res.stdout).toContain("Manifest finalization failed");

    // Config must remain byte-for-byte identical
    expect(readFileSync(configFile, "utf-8")).toBe(originalConfig);
    // Manifest must remain absent
    expect(existsSync(manifestFile)).toBe(false);
  });

  it("flowdeck update re-runs installation check, preserves comments, and completes successfully", () => {
    // Write outdated ref with comments
    const outdatedConfig = '{\n  // outdated comment\n  "plugin": ["@heidi-dang/flowdeck@0.1.0"],\n  "default_agent": "orchestrator"\n}\n';
    writeFileSync(configFile, outdatedConfig, "utf-8");

    // Create old manifest
    const oldManifest = { pluginRef: "@heidi-dang/flowdeck@0.1.0", pluginAdded: true, defaultAgentAdded: true };
    writeFileSync(manifestFile, JSON.stringify(oldManifest), "utf-8");

    const res = runCli(["update"], env);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("Update complete");

    const updatedConfigContent = readFileSync(configFile, "utf-8");
    expect(updatedConfigContent).toContain("// outdated comment"); // Preserves comments

    const parseResult = safeParseConfig(updatedConfigContent);
    expect(parseResult.ok).toBe(true);
    const updatedConfig = parseResult.data;
    expect(updatedConfig.plugin).toContain("@heidi-dang/flowdeck"); // updated to current
    expect(updatedConfig.plugin).not.toContain("@heidi-dang/flowdeck@0.1.0");
    // default agent ownership unchanged
    expect(updatedConfig.default_agent).toBe("orchestrator");

    const newManifest = JSON.parse(readFileSync(manifestFile, "utf-8"));
    expect(newManifest.pluginRef).toBe("@heidi-dang/flowdeck");
  });

  it("flowdeck uninstall --force without manifest removes only exact plugin ref and creates NO manifest", () => {
    const preConfig = '{\n  "plugin": ["@heidi-dang/flowdeck", "other-plugin"],\n  "default_agent": "custom-agent"\n}\n';
    writeFileSync(configFile, preConfig, "utf-8");
    expect(existsSync(manifestFile)).toBe(false);

    const res = runCli(["uninstall", "--force"], env);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("FlowDeck uninstalled");

    const postConfig = JSON.parse(readFileSync(configFile, "utf-8"));
    expect(postConfig.plugin).toEqual(["other-plugin"]);
    expect(postConfig.default_agent).toBe("custom-agent");
    expect(existsSync(manifestFile)).toBe(false);
  });

  it("flowdeck uninstall aborts with non-zero exit if no manifest and --force is missing", () => {
    const preConfig = '{\n  "plugin": ["@heidi-dang/flowdeck"]\n}\n';
    writeFileSync(configFile, preConfig, "utf-8");

    const res = runCli(["uninstall"], env);
    expect(res.code).not.toBe(0);
    expect(res.stdout).toContain("Uninstall aborted");
    expect(readFileSync(configFile, "utf-8")).toBe(preConfig);
  });

  it("flowdeck verify passes after clean install and fails when plugin is missing", () => {
    runCli(["install"], env);
    const v1 = runCli(["verify"], env);
    expect(v1.code).toBe(0);
    expect(v1.stdout).toContain("Verification passed");

    writeFileSync(configFile, '{\n  "plugin": []\n}\n', "utf-8");
    const v2 = runCli(["verify"], env);
    expect(v2.code).not.toBe(0);
  });

  it("flowdeck doctor executes diagnostic checks", () => {
    runCli(["install"], env);
    const res = runCli(["doctor"], env);

    // Assert exit code
    if (res.code !== 0) console.log(res.stdout, res.stderr);
    expect([0, 1]).toContain(res.code); // 0=success, 1=issues found (both valid)

    // Assert doctor output
    expect(res.stdout).toContain("FlowDeck");
    expect(res.stdout).toContain("Doctor");

    // Assert check items present
    expect(res.stdout.length).toBeGreaterThan(100);

    // Assert a summary-like section is present
    const doctorKeywords = ["Checks", "Scores", "Readiness", "Errors", "Warnings", "Recommendations"];
    const matchedKeyword = doctorKeywords.some(kw => res.stdout.includes(kw));
    expect(matchedKeyword).toBe(true);
  });

  it("flowdeck config validate checks syntax of config", () => {
    writeFileSync(configFile, '{\n  "plugin": ["@heidi-dang/flowdeck"]\n}\n', "utf-8");
    const res = runCli(["config", "validate"], env);
    expect(res.code).toBe(0);
    expect(res.stdout.toLowerCase()).toContain("valid");
  });

  it("flowdeck dry-run shows intended changes without writing to disk", () => {
    const initialConfig = '{\n  "plugin": []\n}\n';
    writeFileSync(configFile, initialConfig, "utf-8");

    const res = runCli(["dry-run"], env);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("DRY RUN");
    expect(readFileSync(configFile, "utf-8")).toBe(initialConfig);
  });
});
