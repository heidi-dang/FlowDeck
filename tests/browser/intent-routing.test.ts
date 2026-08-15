import { describe, it, expect } from "bun:test";
import { classifyBrowserDebugIntent } from "../../src/lib/task-routing";
import { createAgent, AGENT_NAMES } from "../../src/agents/index";

describe("Browser Debug Intent Routing & Specialist Agent", () => {
  it("classifies natural language browser debug commands", () => {
    const commands = [
      "Fix all console bugs",
      "Fix console errors",
      "Fix frontend runtime errors",
      "Debug the website",
      "Check the browser for errors",
      "Find UI runtime bugs",
      "Fix React errors",
      "Run the web app and fix it",
      "See why this page is broken",
      "Test the frontend and repair failures",
    ];

    for (const cmd of commands) {
      const classified = classifyBrowserDebugIntent(cmd);
      expect(classified.isBrowserDebug).toBe(true);
      expect(classified.intent).toEqual({
        domain: "frontend",
        operation: "debug-and-repair",
        scope: "browser-runtime",
        completion: "no-actionable-browser-failures",
      });
    }
  });

  it("does not classify non-browser tasks as browser debug", () => {
    expect(classifyBrowserDebugIntent("Refactor database migration script").isBrowserDebug).toBe(false);
    expect(classifyBrowserDebugIntent("Add unit test for math helper").isBrowserDebug).toBe(false);
  });

  it("registers browser-debugger specialist agent in AGENT_NAMES", () => {
    expect(AGENT_NAMES).toContain("browser-debugger");
    const agent = createAgent("browser-debugger");
    expect(agent).toBeDefined();
    expect(agent?.name).toBe("browser-debugger");
  });
});
