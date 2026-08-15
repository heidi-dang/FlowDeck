import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AgentBrowserSession } from "../../src/browser/adapter";

describe("AgentBrowserSession Adapter", () => {
  let session: AgentBrowserSession;

  beforeEach(() => {
    session = new AgentBrowserSession({ mockMode: true });
  });

  afterEach(async () => {
    await session.close();
  });

  it("initializes with session metadata and mock state", async () => {
    expect(session.id).toBeDefined();
    expect(session.currentUrl).toBe("about:blank");
    expect(session.navigationGeneration).toBe(0);
  });

  it("navigates and increments navigation generation", async () => {
    await session.navigate("http://localhost:3000/dashboard");
    expect(session.currentUrl).toBe("http://localhost:3000/dashboard");
    expect(session.navigationGeneration).toBe(1);
  });

  it("collects and redacts console errors and page errors", async () => {
    session.addConsoleEntry({
      type: "error",
      text: "Uncaught TypeError: Cannot read property 'map' of undefined API_KEY=secret123",
      timestamp: new Date().toISOString(),
    });

    const logs = await session.getConsole();
    expect(logs).toHaveLength(1);
    expect(logs[0].text).not.toContain("secret123");
    expect(logs[0].text).toContain("[REDACTED]");
  });

  it("returns interactive snapshot in mock mode", async () => {
    const snap = await session.snapshot({ interactiveOnly: true });
    expect(snap.title).toBe("Mock App Page");
    expect(snap.accessibilityTree).toBeDefined();
  });

  it("throws error when performing operations on closed session", async () => {
    await session.close();
    expect(session.navigate("http://localhost:3000")).rejects.toThrow("closed");
  });
});
