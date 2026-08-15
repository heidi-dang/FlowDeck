import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { findAgentBrowserBinary, detectBrowserCapability } from "../../src/browser/capability";

describe("Real agent-browser CLI Integration Smoke Test", () => {
  it("locates real agent-browser binary and reports capability", async () => {
    const status = await detectBrowserCapability();
    expect(status.available).toBe(true);

    if (status.available) {
      expect(status.provider).toBe("agent-browser");
      expect(status.binaryPath).toBeDefined();
      expect(status.version).toContain("0.26.0");
    }
  });

  it("executes real agent-browser --version command", () => {
    const binaryPath = findAgentBrowserBinary();
    expect(binaryPath).not.toBeNull();

    if (binaryPath) {
      const res = spawnSync(binaryPath, ["--version"], {
        encoding: "utf-8",
        timeout: 5000,
      });

      expect(res.status).toBe(0);
      expect(res.stdout || res.stderr).toContain("0.26.0");
    }
  });
});
