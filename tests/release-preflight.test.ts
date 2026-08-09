import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("release preflight", () => {
  it("validates the exact packed artifact without publication", () => {
    const output = execFileSync("node", ["scripts/release-preflight.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env },
    });
    const result = JSON.parse(output.slice(output.indexOf("{\n")));
    expect(result.status).toBe("PASS");
    expect(result.package).toBe("@heidi-dang/flowdeck");
    expect(result.version).toMatch(/^2\.0\.0-alpha\.\d+$/);
    expect(result.install).toBe("PASS");
    expect(result.cli).toBe("PASS");
    expect(["healthy", "degraded"]).toContain(result.doctor);

    const workflow = readFileSync(join(process.cwd(), ".github/workflows/publish.yml"), "utf8");
    expect(workflow).toContain("npm run verify:release:preflight");
    expect(workflow.indexOf("Release Preflight")).toBeLessThan(workflow.indexOf("npm publish"));
    expect(workflow).not.toContain("continue-on-error: true");
  }, 30000);
});
