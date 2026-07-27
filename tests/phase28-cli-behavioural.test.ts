import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const CLI_PATH = join(process.cwd(), "bin", "flowdeck.js");

function runCli(args: string[], env: Record<string, string>): { code: number; stdout: string; stderr: string } {
  try {
    const nodePath = join(process.cwd(), "node_modules");
    const stdout = execFileSync("node", [CLI_PATH, ...args], {
      env: { ...process.env, NODE_PATH: nodePath, ...env },
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
    // Crucial requirement: forced uninstall without manifest must NOT create a manifest
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

    // Remove plugin from config to trigger verify failure
    writeFileSync(configFile, '{\n  "plugin": []\n}\n', "utf-8");
    const v2 = runCli(["verify"], env);
    expect(v2.code).not.toBe(0);
  });
});
