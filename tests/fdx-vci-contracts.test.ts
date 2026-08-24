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
    expect(res.value.server_capabilities).toContain("impact-v2");
    expect(res.value.server_capabilities).toContain("why-v1");
    expect(res.value.graph_schema_version).toBe(6);
    expect(res.value.selection_policy_version).toBe(1);
    expect(res.value.attestation_predicate_version).toBe(1);
  });

  it("serves impact-v2 and why-v1 queries over resident daemon IPC", async () => {
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
    const responses = new Map<string, any>();
    const pendingPromises = new Map<string, { resolve: (val: any) => void; reject: (err: any) => void }>();

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          responses.set(json.id, json);
          const p = pendingPromises.get(json.id);
          if (p) {
            pendingPromises.delete(json.id);
            p.resolve(json);
          }
        } catch {
          // ignore malformed
        }
      }
    });

    function sendReq(id: string, op: string, args: any): Promise<any> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Daemon response timed out for ${id}`)), 5000);
        pendingPromises.set(id, {
          resolve: (val) => {
            clearTimeout(timer);
            resolve(val);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        });
        child.stdin.write(JSON.stringify({ id, op, args }) + "\n");
      });
    }

    // 1. Request impact-v2
    const impactRes = await sendReq("test-impact-v2", "impact-v2", { depth: 2 });
    expect(impactRes.ok).toBe(true);
    expect(impactRes.value.assurance).toBeDefined();
    expect(Array.isArray(impactRes.value.changes)).toBe(true);
    expect(Array.isArray(impactRes.value.impacted)).toBe(true);
    expect(Array.isArray(impactRes.value.uncertainty)).toBe(true);

    // 2. Request why-v1
    const whyRes = await sendReq("test-why-v1", "why-v1", { target: "src/index.ts", depth: 2 });
    expect(whyRes.ok).toBe(true);

    child.kill();
  });
});