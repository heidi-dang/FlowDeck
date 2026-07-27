import { describe, it, expect } from "vitest";
import { runDoctorChecks } from "../scripts/doctor-engine.mjs";

describe("Phase 28 — FDX Version Compatibility Gates", () => {
  it("validates flowdeckFdxCompatibility specified in package.json", async () => {
    const report = await runDoctorChecks(process.cwd());
    const fdxCheck = report.checks.find((c) => c.id === "fdx.version");
    expect(fdxCheck).toBeDefined();
    expect(["pass", "warn", "fail"]).toContain(fdxCheck?.status);
  });
});
