import { describe, it, expect } from "bun:test";
import { resolveBetterHarnessConfig, DEFAULT_CONFIG } from "../../src/config/agent-models";

describe("Better Harness Config", () => {
  it("missing config enables", () => {
    const r = resolveBetterHarnessConfig({});
    expect(r.enabled).toBe(true);
  });

  it("empty betterHarness enables", () => {
    const r = resolveBetterHarnessConfig({ betterHarness: {} });
    expect(r.enabled).toBe(true);
  });

  it("partial config preserves enabled", () => {
    const r = resolveBetterHarnessConfig({ betterHarness: { authEnabled: true } });
    expect(r.enabled).toBe(true);
    expect(r.authEnabled).toBe(true);
  });

  it("explicit false disables", () => {
    const r = resolveBetterHarnessConfig({ betterHarness: { enabled: false } });
    expect(r.enabled).toBe(false);
  });

  it("full config resolves correctly", () => {
    const r = resolveBetterHarnessConfig({
      betterHarness: {
        enabled: true, port: 8888, bindHost: "0.0.0.0",
        authEnabled: true, authToken: "secret",
        maxBodySize: 4096, corsOrigins: ["https://app.com"],
      },
    });
    expect(r.enabled).toBe(true);
    expect(r.port).toBe(8888);
    expect(r.bindHost).toBe("0.0.0.0");
    expect(r.authEnabled).toBe(true);
    expect(r.authToken).toBe("secret");
    expect(r.maxBodySize).toBe(4096);
    expect(r.corsOrigins).toEqual(["https://app.com"]);
  });

  it("DEFAULT_CONFIG has betterHarness enabled", () => {
    expect(DEFAULT_CONFIG.betterHarness).toBeDefined();
    expect(DEFAULT_CONFIG.betterHarness!.enabled).toBe(true);
  });
});
