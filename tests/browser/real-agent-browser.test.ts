import { describe, it, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { findAgentBrowserBinary, detectBrowserCapability } from "../../src/browser/capability";

describe("Real agent-browser CLI Integration Smoke Test", () => {
  it("locates real agent-browser binary and reports capability", async () => {
    const status = await detectBrowserCapability();
    if (status.available) {
      expect(status.provider).toBe("agent-browser");
      expect(status.binaryPath).toBeDefined();
      expect(status.version).toBeDefined();
    } else {
      expect(status.available).toBe(false);
      expect(status.reason).toBeDefined();
      expect(status.remediation).toBeDefined();
    }
  });

  it("executes real agent-browser --version command", () => {
    const binaryPath = findAgentBrowserBinary();
    if (binaryPath) {
      const res = spawnSync(binaryPath, ["--version"], {
        encoding: "utf-8",
        timeout: 5000,
      });

      expect(res.status).toBe(0);
      expect(res.stdout || res.stderr).toBeDefined();
    } else {
      expect(binaryPath).toBeNull();
    }
  });
});
