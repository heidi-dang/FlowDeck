import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AgentBrowserSession } from "../../src/browser/adapter";

describe("Subprocess Security & Secret Redaction", () => {
  let session: AgentBrowserSession;

  beforeEach(() => {
    session = new AgentBrowserSession({ mockMode: true });
  });

  afterEach(async () => {
    await session.close();
  });

  it("handles URLs, targets, and input values containing shell metacharacters safely", async () => {
    const dangerousUrl = "http://localhost:3000/app?query=test;rm+-rf+/&var=$(whoami)`id`|cat";
    await session.navigate(dangerousUrl);
    expect(decodeURIComponent(session.currentUrl)).toContain("rm+-rf+/");

    // Target with quotes and semicolons
    const target = { selector: "button[data-action='test;echo injection']" };
    await session.click(target);

    // Fill input with malicious shell characters
    await session.fill(target, "user; cat /etc/passwd | grep root && echo 'hacked'");
  });

  it("handles Unicode paths and spaces in URLs and targets", async () => {
    const unicodeUrl = "http://localhost:3000/测试/🎉/dashboard?page=1";
    await session.navigate(unicodeUrl);
    expect(decodeURIComponent(session.currentUrl)).toBe(unicodeUrl);
  });

  it("redacts sensitive query parameters in URLs", async () => {
    const urlWithToken = "http://localhost:3000/api?token=secret123&apiKey=key456&password=pass789";
    await session.navigate(urlWithToken);
    expect(session.currentUrl).not.toContain("secret123");
    expect(session.currentUrl).not.toContain("key456");
    expect(session.currentUrl).not.toContain("pass789");
    expect(decodeURIComponent(session.currentUrl)).toContain("[REDACTED]");
  });

  it("redacts sensitive headers in network entries", async () => {
    session.addNetworkEntry({
      url: "http://localhost:3000/api/user",
      method: "GET",
      status: 200,
      failed: false,
      timestamp: new Date().toISOString(),
      requestHeaders: {
        Authorization: "Bearer secret-jwt-token-12345",
        Cookie: "sessionid=abc123secret",
        "X-Custom-Header": "safe-value",
      },
    });

    const net = await session.getNetworkActivity();
    expect(net).toHaveLength(1);
    expect(net[0].requestHeaders?.["Authorization"]).toBe("[REDACTED]");
    expect(net[0].requestHeaders?.["Cookie"]).toBe("[REDACTED]");
    expect(net[0].requestHeaders?.["X-Custom-Header"]).toBe("safe-value");
  });

  it("redacts credentials from console error messages", async () => {
    session.addConsoleEntry({
      type: "error",
      text: "Failed authentication for Bearer secret-auth-token-xyz api_key=topsecretkey",
      timestamp: new Date().toISOString(),
    });

    const logs = await session.getConsole();
    expect(logs[0].text).not.toContain("secret-auth-token-xyz");
    expect(logs[0].text).not.toContain("topsecretkey");
    expect(logs[0].text).toContain("[REDACTED]");
  });
});
