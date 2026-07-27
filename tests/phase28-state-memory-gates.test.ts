import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateProjectId, planningDir } from "../src/tools/planning-state-lib";
import { repoMemoryTool } from "../src/tools/repo-memory";

describe("Phase 28 — State and Memory Production Gates", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `fd-state-test-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
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
});
