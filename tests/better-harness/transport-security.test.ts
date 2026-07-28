import { describe, it, expect } from "bun:test";
import { createCorsHeaders, validatePreflight, DEFAULT_CORS_CONFIG } from "../../src/better-harness/transport/cors";
import { createAuthCheck } from "../../src/better-harness/transport/authentication";

describe("CORS", () => {
  it("allowed origin echoes exact origin", () => {
    const h = createCorsHeaders({ allowedOrigins: ["https://app.com"], allowedMethods: ["GET"], allowedHeaders: ["X-Custom"] }, "https://app.com");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://app.com");
  });

  it("disallowed origin receives no ACAO", () => {
    const h = createCorsHeaders({ allowedOrigins: ["https://app.com"], allowedMethods: ["GET"], allowedHeaders: ["X-Custom"] }, "https://evil.com");
    expect(h["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("missing origin receives no ACAO", () => {
    const h = createCorsHeaders({ allowedOrigins: ["https://app.com"], allowedMethods: ["GET"], allowedHeaders: ["X-Custom"] });
    expect(h["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("no permission headers for disallowed origin", () => {
    const h = createCorsHeaders({ allowedOrigins: ["https://app.com"], allowedMethods: ["DELETE"], allowedHeaders: ["X-Secret"] }, "https://evil.com");
    expect(h["Access-Control-Allow-Methods"]).toBeUndefined();
    expect(h["Access-Control-Allow-Headers"]).toBeUndefined();
  });

  it("Vary: Origin always present", () => {
    const h = createCorsHeaders(DEFAULT_CORS_CONFIG, "http://localhost:3000");
    expect(h["Vary"]).toBe("Origin");
    const h2 = createCorsHeaders(DEFAULT_CORS_CONFIG);
    expect(h2["Vary"]).toBe("Origin");
  });

  it("valid preflight passes", () => {
    const err = validatePreflight({ allowedOrigins: ["https://app.com"], allowedMethods: ["POST"], allowedHeaders: ["Content-Type"] }, "https://app.com", "POST", "Content-Type");
    expect(err).toBeNull();
  });

  it("missing origin is rejected", () => {
    const err = validatePreflight(DEFAULT_CORS_CONFIG, undefined, "GET", undefined);
    expect(err).toBe("Missing Origin");
  });

  it("unsupported method is rejected", () => {
    const err = validatePreflight({ allowedOrigins: ["https://app.com"], allowedMethods: ["GET"], allowedHeaders: [] }, "https://app.com", "DELETE", undefined);
    expect(err).toContain("Method not allowed");
  });

  it("unsupported header is rejected (case-insensitive)", () => {
    const err = validatePreflight({ allowedOrigins: ["https://app.com"], allowedMethods: ["GET"], allowedHeaders: ["x-custom"] }, "https://app.com", "GET", "X-SECRET");
    expect(err).toContain("Header not allowed");
  });

  it("supported header passes (case-insensitive)", () => {
    const err = validatePreflight({ allowedOrigins: ["https://app.com"], allowedMethods: ["GET"], allowedHeaders: ["X-Custom"] }, "https://app.com", "GET", "x-custom");
    expect(err).toBeNull();
  });
});

describe("Authentication", () => {
  it("auth disabled permits all", () => {
    const check = createAuthCheck({ token: null, enabled: false });
    expect(check()).toBe(true);
    expect(check("any")).toBe(true);
  });

  it("auth enabled with no token rejects all", () => {
    const check = createAuthCheck({ token: null, enabled: true });
    expect(check()).toBe(false);
    expect(check("anything")).toBe(false);
  });

  it("auth enabled rejects missing token", () => {
    const check = createAuthCheck({ token: "secret", enabled: true });
    expect(check()).toBe(false);
  });

  it("auth enabled rejects invalid token", () => {
    const check = createAuthCheck({ token: "secret", enabled: true });
    expect(check("wrong")).toBe(false);
  });

  it("auth enabled accepts valid token", () => {
    const check = createAuthCheck({ token: "secret123", enabled: true });
    expect(check("secret123")).toBe(true);
  });

  it("constant-time comparison works for equal-length tokens", () => {
    const check = createAuthCheck({ token: "abcdefghijklmnop", enabled: true });
    expect(check("abcdefghijklmnop")).toBe(true);
    expect(check("abcdefghijklmnoq")).toBe(false);
    expect(check("abcdefghijklmno")).toBe(false);
  });
});
