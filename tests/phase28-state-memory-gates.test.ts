import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock the 'os' module to control homedir dynamically
vi.mock("os", () => {
  return {
    homedir: () => (globalThis as any).__mockHomedir || require("node:os").homedir(),
  };
});

// Mock the 'fs' module to inject read errors for interrupted migration recovery testing
vi.mock("fs", () => {
  const original = require("node:fs");
  return {
    ...original,
    readFileSync: (path: any, options: any) => {
      if (typeof path === "string" && path.includes("legacy-home-err")) {
        throw new Error("Injected disk read failure");
      }
      return original.readFileSync(path, options);
    },
  };
});

import { generateProjectId, planningDir } from "../src/tools/planning-state-lib";
import { repoMemoryTool } from "../src/tools/repo-memory";
import { appendJsonlWithRotation, readJsonlQuarantine } from "../src/tools/jsonl-log";

describe("Phase 28 — State and Memory Production Gates", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `fd-state-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpRoot, { recursive: true });
    (globalThis as any).__mockHomedir = undefined;
  });

  afterEach(() => {
    (globalThis as any).__mockHomedir = undefined;
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("isolates state for two repositories with identical folder names in different directories", () => {
    const dirA = join(tmpRoot, "a", "my-repo");
    const dirB = join(tmpRoot, "b", "my-repo");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });

    const idA = generateProjectId(dirA);
    const idB = generateProjectId(dirB);

    expect(idA).not.toEqual(idB);
    expect(idA.startsWith("my-repo-")).toBe(true);
    expect(idB.startsWith("my-repo-")).toBe(true);

    const planDirA = planningDir(dirA);
    const planDirB = planningDir(dirB);
    expect(planDirA).not.toEqual(planDirB);
  });

  it("rejects durable memory mutations by specialist agents", async () => {
    const repoDir = join(tmpRoot, "spec-repo");
    mkdirSync(join(repoDir, ".codebase"), { recursive: true });

    // Specialist agent 'backend-coder' attempts write_node
    const resWrite = await repoMemoryTool.execute(
      {
        action: "write_node",
        node_id: "test-node",
        node: { type: "service", path: "src/auth.ts", tags: ["auth"], dependencies: [], dependents: [], bug_history: [], conventions: [] },
      },
      { directory: repoDir, agent: "backend-coder" } as any
    );

    const strWrite = typeof resWrite === "string" ? resWrite : (resWrite as any).output;
    const parsedWrite = JSON.parse(strWrite);
    expect(parsedWrite.error).toContain("Specialist agent");
    expect(parsedWrite.error).toContain("not permitted");

    // Coordinator agent 'heidi' attempts write_node
    const resWriteHeidi = await repoMemoryTool.execute(
      {
        action: "write_node",
        node_id: "test-node",
        node: { type: "service", path: "src/auth.ts", tags: ["auth"], dependencies: [], dependents: [], bug_history: [], conventions: [] },
      },
      { directory: repoDir, agent: "heidi" } as any
    );

    const strWriteHeidi = typeof resWriteHeidi === "string" ? resWriteHeidi : (resWriteHeidi as any).output;
    const parsedWriteHeidi = JSON.parse(strWriteHeidi);
    expect(parsedWriteHeidi.success).toBe(true);
  });

  it("quarantines corrupt MEMORY.json and creates fresh state without crashing", async () => {
    const repoDir = join(tmpRoot, "corrupt-mem-repo");
    const codebasePath = join(repoDir, ".codebase");
    mkdirSync(codebasePath, { recursive: true });
    const memFile = join(codebasePath, "MEMORY.json");
    writeFileSync(memFile, "{ corrupt json data {{", "utf-8");

    // Reading memory should quarantine the corrupt file and return fresh memory
    const resRead = await repoMemoryTool.execute(
      { action: "read" },
      { directory: repoDir, agent: "heidi" } as any
    );

    const strRead = typeof resRead === "string" ? resRead : (resRead as any).output;
    const parsedRead = JSON.parse(strRead);
    expect(parsedRead.nodes).toBeDefined();

    // Verify quarantine file was created
    const files = readdirSync(codebasePath);
    const quarantine = files.find(f => f.startsWith("MEMORY.json.quarantine"));
    expect(quarantine).toBeDefined();
  });

  it("supports memory node querying, updating, and deletion by primary agent", async () => {
    const repoDir = join(tmpRoot, "query-repo");
    mkdirSync(join(repoDir, ".codebase"), { recursive: true });

    // Write a node
    await repoMemoryTool.execute(
      {
        action: "write_node",
        node_id: "auth-service",
        node: { type: "service", path: "src/services/auth.ts", owner: "security-team", tags: ["auth", "security"], dependencies: [], dependents: [], bug_history: [], conventions: [] },
      },
      { directory: repoDir, agent: "heidi" } as any
    );

    // Query node
    const resQuery = await repoMemoryTool.execute(
      {
        action: "query",
        query: { type: "service", path_prefix: "src/services" },
      },
      { directory: repoDir, agent: "heidi" } as any
    );

    const strQuery = typeof resQuery === "string" ? resQuery : (resQuery as any).output;
    const parsedQuery = JSON.parse(strQuery);
    expect(parsedQuery.count).toBe(1);
    expect(parsedQuery.nodes[0].id).toBe("auth-service");

    // Delete node
    const resDelete = await repoMemoryTool.execute(
      {
        action: "delete_node",
        node_id: "auth-service",
      },
      { directory: repoDir, agent: "heidi" } as any
    );

    const strDelete = typeof resDelete === "string" ? resDelete : (resDelete as any).output;
    const parsedDelete = JSON.parse(strDelete);
    expect(parsedDelete.success).toBe(true);
  });

  // ── Legacy state migration and recovery tests ────────────────────────────

  it("migrates legacy basename state to project ID state with backup", () => {
    // Set up legacy planning dir at homedir()/.fd-plan/my-repo
    const mockHome = join(tmpRoot, "legacy-home");
    const legacyPath = join(mockHome, ".fd-plan", "my-repo");
    mkdirSync(legacyPath, { recursive: true });
    writeFileSync(join(legacyPath, "STATE.md"), "Legacy State Content");
    writeFileSync(join(legacyPath, "plan.md"), "Legacy Plan Content");

    (globalThis as any).__mockHomedir = mockHome;

    const repoPath = join(tmpRoot, "repos", "my-repo");
    mkdirSync(repoPath, { recursive: true });

    // Call planningDir which triggers migration
    const resolvedNewDir = planningDir(repoPath);

    // Verify it migrated files
    expect(existsSync(join(resolvedNewDir, "STATE.md"))).toBe(true);
    expect(readFileSync(join(resolvedNewDir, "STATE.md"), "utf-8")).toBe("Legacy State Content");
    expect(readFileSync(join(resolvedNewDir, "plan.md"), "utf-8")).toBe("Legacy Plan Content");

    // Legacy path should be backed up/renamed to .bak.<timestamp>
    const files = readdirSync(join(mockHome, ".fd-plan"));
    const bakDir = files.find(f => f.startsWith("my-repo.bak."));
    expect(bakDir).toBeDefined();
  });

  it("cleans up new directory if migration is interrupted", () => {
    const mockHome = join(tmpRoot, "legacy-home-err");
    const legacyPath = join(mockHome, ".fd-plan", "my-repo");
    mkdirSync(legacyPath, { recursive: true });
    writeFileSync(join(legacyPath, "STATE.md"), "Legacy State Content");

    (globalThis as any).__mockHomedir = mockHome;

    const repoPath = join(tmpRoot, "repos", "my-repo");
    mkdirSync(repoPath, { recursive: true });

    const newDir = planningDir(repoPath);

    // The new directory should be cleaned up (deleted) because of the injected read failure
    expect(existsSync(newDir)).toBe(false);
  });

  // ── JSONL Log production-readiness tests ──────────────────────────────────

  it("enforces record-size limits in JSONL logging", async () => {
    const logFile = join(tmpRoot, "test.jsonl");
    const hugeRecord = { data: "a".repeat(1024 * 1024 + 10) }; // > 1MB
    const res = await appendJsonlWithRotation(logFile, hugeRecord);
    expect(res.success).toBe(false);
    expect(res.error).toBe("Record size limit exceeded");
  });

  it("enforces file-size limits, rotation, and retention of at most 5 rotated files", async () => {
    const logFile = join(tmpRoot, "rotate-test.jsonl");
    const record = { data: "a".repeat(600 * 1024) }; // ~600KB record

    // Write 1st record: file size becomes ~600KB
    let res = await appendJsonlWithRotation(logFile, record);
    expect(res.success).toBe(true);
    expect(statSync(logFile).size).toBeGreaterThan(600 * 1024);

    // Write 2nd record: size + line.length > 1MB -> rotates!
    res = await appendJsonlWithRotation(logFile, record);
    expect(res.success).toBe(true);

    // There should be a rotated file
    const files = readdirSync(tmpRoot);
    const rotated = files.filter(f => f.startsWith("rotate-test.jsonl."));
    expect(rotated.length).toBe(1);

    // Verify retention: write multiple records to trigger more rotations
    for (let i = 0; i < 6; i++) {
      // Minimal sleep to guarantee unique timestamps in rotated filenames
      await new Promise(r => setTimeout(r, 5));
      await appendJsonlWithRotation(logFile, record);
    }

    const rotatedAfter = readdirSync(tmpRoot).filter(f => f.startsWith("rotate-test.jsonl."));
    // It should retain at most 5 rotated files
    expect(rotatedAfter.length).toBeLessThanOrEqual(5);
  });

  it("quarantines corrupt JSONL lines and preserves valid lines", () => {
    const logFile = join(tmpRoot, "quarantine-test.jsonl");
    writeFileSync(logFile, '{"a":1}\n{invalid json}\n{"b":2}\n', "utf-8");

    const res = readJsonlQuarantine(logFile);
    expect(res.records).toEqual([{ a: 1 }, { b: 2 }]);

    // Valid lines should stay in the original file
    expect(readFileSync(logFile, "utf-8")).toBe('{"a":1}\n{"b":2}\n');

    // Corrupt lines should be quarantined
    const files = readdirSync(tmpRoot);
    const quarantine = files.find(f => f.startsWith("quarantine-test.jsonl.quarantine."));
    expect(quarantine).toBeDefined();
    expect(readFileSync(join(tmpRoot, quarantine!), "utf-8")).toBe('{invalid json}\n');
  });
});
