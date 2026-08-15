import { describe, it, expect } from "bun:test";
import { DevServerManager } from "../../src/browser/dev-server-manager";

describe("DevServerManager", () => {
  it("discovers dev server command and script for current repo", async () => {
    const manager = new DevServerManager();
    const info = await manager.discoverDevServer();
    expect(info).toHaveProperty("command");
    expect(info).toHaveProperty("cwd");
    expect(info).toHaveProperty("port");
    expect(info.isExternallyOwned).toBe(false);
  });

  it("attaches to existing listening port if available", async () => {
    const manager = new DevServerManager();
    // Ensure port detection does not throw and returns info structure
    const info = await manager.discoverDevServer({ requestedPort: 65530 });
    expect(info.port).toBe(65530);
  });
});
