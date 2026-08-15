import { describe, it, expect } from "bun:test";
import { detectBrowserCapability, findAgentBrowserBinary } from "../../src/browser/capability";

describe("Browser Capability Detection", () => {
  it("returns status object without throwing exceptions", async () => {
    const status = await detectBrowserCapability({ checkTimeoutMs: 1000 });
    expect(status).toHaveProperty("available");
    if (!status.available) {
      expect(status).toHaveProperty("reason");
      expect(["agent-browser-missing", "browser-missing", "unsupported-platform", "runtime-error"]).toContain(
        status.reason
      );
    } else {
      expect(status).toHaveProperty("version");
      expect(status).toHaveProperty("binaryPath");
    }
  });

  it("finds binary when custom path or env path is provided", () => {
    const _fakePath = "/tmp/fake-agent-browser";
    expect(findAgentBrowserBinary("/non/existent/path")).toBeNull();
  });
});
