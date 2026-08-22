import { describe, it, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { resolveFdxBinaryPath } from "../src/tools/fdx-shared";

describe("FDX VCI Contracts & Ground Truth", () => {
  const root = process.cwd();

  it("loads and validates ground-truth.json schema", () => {
    const gtPath = join(root, "tests/fixtures/vci-ground-truth/ground-truth.json");
    expect(existsSync(gtPath)).toBe(true);

    const raw = readFileSync(gtPath, "utf8");
    const groundTruth = JSON.parse(raw);

    expect(groundTruth.version).toBe(1);
    expect(groundTruth.fixture).toBe("vci-ground-truth");
    expect(Array.isArray(groundTruth.nodes)).toBe(true);
    expect(Array.isArray(groundTruth.edges)).toBe(true);
    expect(Array.isArray(groundTruth.changed)).toBe(true);
    expect(Array.isArray(groundTruth.impact)).toBe(true);
    expect(Array.isArray(groundTruth.tests)).toBe(true);
    expect(Array.isArray(groundTruth.unknowns)).toBe(true);
    expect(Array.isArray(groundTruth.verificationExpansion)).toBe(true);

    // Verify presence of cyclical edge and dynamic import
    const hasCycle = groundTruth.edges.some((e: any) => e.cycle === true);
    expect(hasCycle).toBe(true);

    const hasDynamic = groundTruth.edges.some((e: any) => e.dynamic === true);
    expect(hasDynamic).toBe(true);
  });

  it("verifies all referenced fixture files exist on disk", () => {
    const gtPath = join(root, "tests/fixtures/vci-ground-truth/ground-truth.json");
    const groundTruth = JSON.parse(readFileSync(gtPath, "utf8"));

    for (const node of groundTruth.nodes) {
      const fullPath = join(root, "tests/fixtures/vci-ground-truth", node.path);
      expect(existsSync(fullPath)).toBe(true);
    }
  });

  it("performs capability negotiation over native daemon IPC", async () => {
    const candidateTarget = join(root, "target/debug", process.platform === "win32" ? "fdx.exe" : "fdx");
    const binaryPath = existsSync(candidateTarget) ? candidateTarget : resolveFdxBinaryPath();
    if (!binaryPath || !existsSync(binaryPath)) {
      console.warn("Skipping native daemon test: fdx binary not found");
      return;
    }

    const child = spawn(binaryPath, ["serve"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    const responsePromise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Daemon response timed out")), 5000);
      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString("utf8");
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            if (json.id === "test-neg-1") {
              clearTimeout(timer);
              resolve(json);
            }
          } catch (e) {
            reject(e);
          }
        }
      });
    });

    // Send negotiate request
    const req = {
      id: "test-neg-1",
      op: "negotiate",
      args: {
        protocol: 2,
        capabilities: ["search", "outline", "vci-v1", "custom-cap"],
      },
    };
    child.stdin.write(JSON.stringify(req) + "\n");

    const res = await responsePromise;
    child.kill();

    expect(res.ok).toBe(true);
    expect(res.value.protocol).toBe(2);
    expect(res.value.selected_capabilities).toContain("search");
    expect(res.value.selected_capabilities).not.toContain("custom-cap");
    expect(res.value.graph_schema_version).toBe(3);
    expect(res.value.selection_policy_version).toBe(1);
    expect(res.value.attestation_predicate_version).toBe(1);
  });
});