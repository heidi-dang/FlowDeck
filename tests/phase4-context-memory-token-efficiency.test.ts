import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  formatContextPacket,
  routeContextRead,
  SessionContextHygiene,
  MAX_CONTEXT_PACKET_CHARS,
} from "@/services/token-optimizer-service"
import { repoMemoryTool } from "@/tools/repo-memory"
import type { McpAvailability } from "@/mcp/index"

const TMP = join(tmpdir(), "phase4-test-" + Date.now())

describe("Phase 4 — Context, Memory, and Token Efficiency", () => {
  beforeEach(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  describe("1. Token-Saving Context Packets", () => {
    it("formats a compact context packet capped under 400 tokens (~1600 chars)", () => {
      const packet = formatContextPacket({
        target: "src/index.ts:L12-45",
        blastRadius: "src/app.ts",
        patterns: ["Use ESM imports", "No floating promises"],
        priorLessons: "Always check file bounds",
        constraints: "Node >= 24",
        stage: "fd-execute",
      })

      expect(packet).toContain("Target: src/index.ts:L12-45")
      expect(packet).toContain("Blast radius: src/app.ts")
      expect(packet).toContain("Stage: fd-execute")
      expect(packet.length).toBeLessThanOrEqual(MAX_CONTEXT_PACKET_CHARS)
    })

    it("truncates oversized context packet inputs to stay under char cap", () => {
      const hugeString = "x".repeat(3000)
      const packet = formatContextPacket({
        target: hugeString,
        stage: "fd-task",
      })

      expect(packet.length).toBeLessThanOrEqual(MAX_CONTEXT_PACKET_CHARS)
      expect(packet).toContain("...")
    })
  })

  describe("2. Token-Optimizer MCP Routing & Fallbacks", () => {
    const tokenOptAvailable: McpAvailability[] = [
      { name: "tokenOptimizer", available: true, enabled: true, type: "local" },
    ]

    const tokenOptUnavailable: McpAvailability[] = [
      { name: "tokenOptimizer", available: false, enabled: true, type: "local", unavailableReason: "not installed" },
    ]

    it("routes large reads (>= 1000 tokens) to token-optimizer when available", () => {
      const res = routeContextRead({
        filePath: "src/big-file.ts",
        estimatedTokens: 2500,
        availability: tokenOptAvailable,
      })

      expect(res.action).toBe("token_optimizer")
      expect(res.toolFamily?.family).toBe("token-optimizer")
    })

    it("falls back gracefully to targeted read with line bounds when token-optimizer is unavailable", () => {
      const res = routeContextRead({
        filePath: "src/big-file.ts",
        totalLines: 500,
        estimatedTokens: 2500,
        availability: tokenOptUnavailable,
      })

      expect(res.action).toBe("targeted_read")
      expect(res.recommendedStartLine).toBe(1)
      expect(res.recommendedEndLine).toBe(100)
      expect(res.reason).toContain("narrow line bounds")
    })

    it("uses standard targeted read for small files (< 1000 tokens)", () => {
      const res = routeContextRead({
        filePath: "src/small.ts",
        estimatedTokens: 300,
        startLine: 1,
        endLine: 50,
        availability: tokenOptAvailable,
      })

      expect(res.action).toBe("targeted_read")
      expect(res.recommendedStartLine).toBe(1)
      expect(res.recommendedEndLine).toBe(50)
    })
  })

  describe("3. Repo-Memory Structural Alignment", () => {
    it("stores and queries structural findings without full file bodies", async () => {
      const mockContext: any = { directory: TMP }

      // Write structural node
      const writeRes: any = await repoMemoryTool.execute(
        {
          action: "write_node",
          node_id: "auth-service",
          node: {
            type: "service",
            path: "src/services/auth.ts",
            tags: ["auth", "security"],
            dependencies: ["db-service"],
            dependents: ["user-router"],
            bug_history: ["Session fixation fixed in v0.4"],
            conventions: ["Strict JWT validation"],
          },
        },
        mockContext
      )

      const writeStr = typeof writeRes === "string" ? writeRes : writeRes.output
      expect(JSON.parse(writeStr)).toEqual({ success: true, node_id: "auth-service" })

      // Query node
      const queryRes: any = await repoMemoryTool.execute(
        {
          action: "query",
          query: { type: "service", tag: "auth" },
        },
        mockContext
      )

      const queryStr = typeof queryRes === "string" ? queryRes : queryRes.output
      const parsedQuery = JSON.parse(queryStr)
      expect(parsedQuery.count).toBe(1)
      expect(parsedQuery.nodes[0].id).toBe("auth-service")
      expect(parsedQuery.nodes[0].path).toBe("src/services/auth.ts")
    })
  })

  describe("4. Session Context Hygiene", () => {
    it("tracks file dumps and prunes stale context at stage boundaries", () => {
      const hygiene = new SessionContextHygiene()
      const sessionID = "sess-123"

      hygiene.recordDump(sessionID, "dump-1")
      hygiene.recordDump(sessionID, "dump-2")
      expect(hygiene.getDumpCount(sessionID)).toBe(2)

      const pruned = hygiene.pruneStageBoundaryContext(sessionID, "fd-execute")
      expect(pruned.prunedCount).toBe(2)
      expect(pruned.stage).toBe("fd-execute")
      expect(hygiene.getDumpCount(sessionID)).toBe(0)
    })
  })
})
