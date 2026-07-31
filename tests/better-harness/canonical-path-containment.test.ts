import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isPathContained, normalizePath, ProjectRegistry } from "@/better-harness/runtime/project-registry";

describe("Canonical Path Containment & macOS /var Resolution", () => {
  const tempBase = mkdtempSync(join(tmpdir(), "path-containment-test-"));

  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true });
  });

  it("handles real child path containment", () => {
    const rootDir = join(tempBase, "project");
    const childDir = join(rootDir, "src", "components");
    mkdirSync(childDir, { recursive: true });

    expect(isPathContained(rootDir, childDir)).toBe(true);
  });

  it("handles symlink alias containment", () => {
    const rootDir = join(tempBase, "real-project");
    const linkDir = join(tempBase, "link-project");
    mkdirSync(rootDir, { recursive: true });
    symlinkSync(rootDir, linkDir, process.platform === "win32" ? "junction" : "dir");

    expect(isPathContained(rootDir, linkDir)).toBe(true);
  });

  it("rejects sibling path", () => {
    const rootDir = join(tempBase, "project");
    const siblingDir = join(tempBase, "other-project");
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });

    expect(isPathContained(rootDir, siblingDir)).toBe(false);
  });

  it("rejects prefix collisions (e.g. /project vs /project-copy)", () => {
    const rootDir = join(tempBase, "project");
    const copyDir = join(tempBase, "project-copy");
    mkdirSync(rootDir, { recursive: true });
    mkdirSync(copyDir, { recursive: true });

    expect(isPathContained(rootDir, copyDir)).toBe(false);
  });

  it("rejects .. traversal", () => {
    const rootDir = join(tempBase, "project");
    const childDir = join(rootDir, "child");
    const secretDir = join(tempBase, "secret");
    mkdirSync(childDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true });

    const traversalPath = join(childDir, "..", "..", "secret");
    expect(isPathContained(rootDir, traversalPath)).toBe(false);
  });

  it("normalizes Windows separators and drive-letter casing", () => {
    expect(normalizePath("c:\\Users\\Shacker\\project")).toBe("C:/Users/Shacker/project");
    expect(normalizePath("C:/Users/Shacker/project")).toBe("C:/Users/Shacker/project");
  });

  it("registers in ProjectRegistry with macOS /var alias support", () => {
    const rootDir = join(tempBase, "mac-project");
    mkdirSync(rootDir, { recursive: true });

    const registry = new ProjectRegistry();
    expect(() => {
      registry.register({
        serverKey: "server-1",
        projectKey: "proj-1",
        canonicalProjectRoot: rootDir,
      });
    }).not.toThrow();

    expect(registry.resolve("server-1", "proj-1")).toBeTruthy();
  });
});
