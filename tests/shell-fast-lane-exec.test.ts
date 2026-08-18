import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  executeShellCommand,
  bashSpawnCount,
  resetBashSpawnCount,
} from "../src/services/shell-executor"

const repoRoot = join(__dirname, "..")
let tmpDir = ""
let tmpFile = ""

function makeTmpFile(lines: string[]): string {
  const file = join(tmpDir, "sample.txt");
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

const SAMPLE = ["line-a", "line-b", "line-c", "line-d", "line-e", "line-f"];

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fastlane-exec-"));
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("shell fast-lane EXECUTION (zero bash spawn)", () => {
  it("cat <file> runs the file-read adapter: bashSpawned=false, count stays 0, output == full file", () => {
    resetBashSpawnCount();
    tmpFile = makeTmpFile(SAMPLE);
    const r = executeShellCommand("cat " + tmpFile, { cwd: tmpDir });
    expect(r.bashSpawned).toBe(false);
    expect(r.adapter).toBe("file-read");
    expect(bashSpawnCount).toBe(0);
    expect(r.output).toBe(SAMPLE.join("\n") + "\n");
    expect(r.output).toBe(readFileSync(tmpFile, "utf8"));
  });

  it("cat output equals readFileSync result byte-for-byte (equivalence)", () => {
    const raw = ["alpha", "beta", "gamma  ", "", "  omega  ", "zeta"];
    const file = join(tmpDir, "eq.txt");
    writeFileSync(file, raw.join("\n") + "\n");
    const r = executeShellCommand("cat " + file, { cwd: tmpDir });
    expect(r.bashSpawned).toBe(false);
    expect(r.output).toBe(readFileSync(file, "utf8"));
    expect(r.output).toBe(raw.join("\n") + "\n");
  });

  it("sed -n '3,5p' <file> slices lines 3..5 (file-read-range)", () => {
    resetBashSpawnCount();
    tmpFile = makeTmpFile(SAMPLE);
    const r = executeShellCommand("sed -n '3,5p' " + tmpFile, { cwd: tmpDir });
    expect(r.bashSpawned).toBe(false);
    expect(r.adapter).toBe("file-read-range");
    expect(bashSpawnCount).toBe(0);
    // lines 3..5 = "line-c","line-d","line-e"
    expect(r.output).toBe("line-c\nline-d\nline-e");
  });

  it("git status in the repo runs git adapter: bashSpawned=false, non-empty", () => {
    resetBashSpawnCount();
    const r = executeShellCommand("git status", { cwd: repoRoot });
    expect(r.bashSpawned).toBe(false);
    expect(r.adapter).toBe("git-status");
    expect(bashSpawnCount).toBe(0);
    expect(r.output.length).toBeGreaterThan(0);
  });

  it("unsafe commands fall back to bash: bashSpawned=true, count increases, real result", () => {
    resetBashSpawnCount();
    const c0 = bashSpawnCount;

    const r1 = executeShellCommand("rm -rf /tmp/fastlane-nonexistent-x", { cwd: tmpDir });
    expect(r1.bashSpawned).toBe(true);
    expect(r1.adapter).toBeNull();
    expect(bashSpawnCount).toBe(c0 + 1);

    const c1 = bashSpawnCount;
    const r2 = executeShellCommand("echo a | base64", { cwd: tmpDir });
    expect(r2.bashSpawned).toBe(true);
    expect(bashSpawnCount).toBe(c1 + 1);
    expect(r2.output).toContain("YQo="); // base64 of "a\n"

    const c2 = bashSpawnCount;
    const r3 = executeShellCommand("FOO=1 cat " + tmpFile + " && rm -f " + join(tmpDir, "nope.txt"), { cwd: tmpDir });
    expect(r3.bashSpawned).toBe(true);
    expect(bashSpawnCount).toBe(c2 + 1);
    expect(r3.output).toContain("line-a");
  });

  it("ls <dir> runs dir-list adapter with no bash spawn", () => {
    resetBashSpawnCount();
    // create a known file in tmpDir and list it
    const marker = join(tmpDir, "marker-xyz.txt");
    writeFileSync(marker, "hello");
    const r = executeShellCommand("ls " + tmpDir, { cwd: tmpDir });
    expect(r.bashSpawned).toBe(false);
    expect(r.adapter).toBe("dir-list");
    expect(bashSpawnCount).toBe(0);
    expect(r.output.split("\n")).toContain("marker-xyz.txt");
  });
});
