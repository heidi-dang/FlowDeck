import { describe, it, expect } from "vitest";
import { runDoctorChecks, testFdxVersionCompatibility } from "../scripts/doctor-engine.mjs";

describe("Phase 28 — FDX Version Compatibility Gates", () => {
  const pkgRaw = JSON.stringify({
    name: "@heidi-dang/flowdeck",
    flowdeckFdxCompatibility: { required: "^0.1.0" },
  });

  it("validates flowdeckFdxCompatibility specified in package.json via doctor", async () => {
    const report = await runDoctorChecks(process.cwd());
    const fdxCheck = report.checks.find((c: { id: string }) => c.id === "fdx.version");
    expect(fdxCheck).toBeDefined();
    expect(["pass", "warn", "fail"]).toContain(fdxCheck?.status);
  });

  it("passes for compatible version fdx 0.1.0", () => {
    const res = testFdxVersionCompatibility(process.cwd(), pkgRaw, "fdx 0.1.0\n");
    expect(res.status).toBe("pass");
    expect(res.message).toContain("satisfies ^0.1.0");
  });

  it("fails for old version fdx 0.0.9", () => {
    const res = testFdxVersionCompatibility(process.cwd(), pkgRaw, "fdx 0.0.9\n");
    expect(res.status).toBe("fail");
    expect(res.message).toContain("too old for ^0.1.0");
  });

  it("fails for unsupported newer version fdx 0.2.0", () => {
    const res = testFdxVersionCompatibility(process.cwd(), pkgRaw, "fdx 0.2.0\n");
    expect(res.status).toBe("fail");
    expect(res.message).toContain("newer than ^0.1.0");
  });

  it("fails explicitly on malformed output", () => {
    const res = testFdxVersionCompatibility(process.cwd(), pkgRaw, "invalid output string");
    expect(res.status).toBe("fail");
    expect(res.message).toContain("malformed output");
  });

  it("reports fallback explicitly when binary is missing", () => {
    const res = testFdxVersionCompatibility(process.cwd(), pkgRaw, null as any);
    expect(res.status).toBe("warn");
    expect(res.message).toBe("FDX binary not found — fallback active");
  });
});
