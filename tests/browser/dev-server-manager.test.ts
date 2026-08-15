import { describe, it, expect, afterEach } from "bun:test";
import { DevServerManager, stopAllOwnedServers, getOwnedProcessesCount } from "../../src/browser/dev-server-manager";

describe("DevServerManager Process Ownership & Lifecycle", () => {
  afterEach(() => {
    stopAllOwnedServers();
  });

  it("discovers dev server command and script for current repo", async () => {
    const manager = new DevServerManager();
    const info = await manager.discoverDevServer();
    expect(info).toHaveProperty("command");
    expect(info).toHaveProperty("cwd");
    expect(info).toHaveProperty("port");
    expect(info.isExternallyOwned).toBe(false);
  });

  it("attaches to external server with isExternallyOwned=true and stop() is a no-op", async () => {
    const manager = new DevServerManager();
    const mockServer = await manager.ensureDevServer({ mockMode: true, requestedPort: 3000 });

    expect(mockServer.info.isExternallyOwned).toBe(true);
    expect(mockServer.info.port).toBe(3000);

    // Initial owned processes count
    const countBefore = getOwnedProcessesCount();
    await mockServer.stop();
    // Count remains unchanged (no external process was killed)
    expect(getOwnedProcessesCount()).toBe(countBefore);
  });

  it("handles startup cancellation via AbortSignal", async () => {
    const manager = new DevServerManager();
    const controller = new AbortController();
    controller.abort();

    expect(
      manager.ensureDevServer({ requestedPort: 59999 }, controller.signal)
    ).rejects.toThrow("aborted");
  });
});
