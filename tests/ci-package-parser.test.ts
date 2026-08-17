import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

describe("CI Package JSON Parser Regression", () => {
  it("ci.yml reads entire JSON string synchronously from stdin instead of using process.stdin.on('data')", () => {
    const ciYml = readFileSync(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    // Verify the unbuffered process.stdin.on('data') pattern is removed
    expect(ciYml).not.toContain("process.stdin.on('data'");
    // Verify synchronous whole-stream stdin buffering is used
    expect(ciYml).toContain("require('fs').readFileSync(0,'utf-8')");
  });
});
