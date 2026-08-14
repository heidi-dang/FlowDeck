import { describe, it, expect } from "bun:test";
import { enforceCommandSecurity, CommandSecurityException } from "../../../src/orchestration/commands/security/command-security";
import type { CommandInvocation } from "../../../src/orchestration/commands/domain/command-definition";

describe("M9 Command Security", () => {
  function makeInvocation(input: any): CommandInvocation {
    return {
      invocationId: "inv-1",
      commandId: "test",
      commandVersion: 1,
      idempotencyKey: "ik-1",
      status: "pending",
      input,
      retryCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
  }

  it("allows safe input", () => {
    expect(() => enforceCommandSecurity(makeInvocation({ taskDescription: "build api" }))).not.toThrow();
  });

  it("blocks path traversal", () => {
    expect(() => enforceCommandSecurity(makeInvocation({ path: "../../../etc/passwd" }))).toThrow(CommandSecurityException);
    try {
      enforceCommandSecurity(makeInvocation({ path: "../../../etc/passwd" }));
    } catch (e: any) {
      expect(e.code).toBe("PATH_TRAVERSAL");
    }
  });

  it("blocks shell injection", () => {
    expect(() => enforceCommandSecurity(makeInvocation({ query: "find . ; rm -rf /" }))).toThrow(CommandSecurityException);
    try {
      enforceCommandSecurity(makeInvocation({ query: "find . ; rm -rf /" }));
    } catch (e: any) {
      expect(e.code).toBe("SHELL_INJECTION");
    }
  });

  it("blocks verification bypass attempts", () => {
    expect(() => enforceCommandSecurity(makeInvocation({ bypassVerification: true }))).toThrow(CommandSecurityException);
    try {
      enforceCommandSecurity(makeInvocation({ bypassVerification: true }));
    } catch (e: any) {
      expect(e.code).toBe("VERIFICATION_BYPASS");
    }
  });
});
