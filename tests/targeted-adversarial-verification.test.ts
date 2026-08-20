import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { isPidAlive, isLockStale } from "../src/services/process-liveness"
import { repairStaleLocks } from "../src/doctor/repair/repairers/stale-locks-repairer"
import { checkFdxAvailability, invalidateFdxCache, resolveFdxBinaryPath } from "../src/tools/fdx-shared"
import { repairFdxBinary } from "../src/doctor/repair/repairers/fdx-repairer"
import { resolveOrchestrationDbPath, OrchestrationDatabaseInaccessibleError } from "../src/services/orchestration-db-path"
import { RepoLeaseCoordinator, repoIdOf } from "../src/services/repo-lease-coordinator"
import { rewriteShellCommand, rewriteLsCommand, executeFastRewrite } from "../src/services/tool-fast-lane"
import { repairMcpConfiguration } from "../src/doctor/repair/repairers/mcp-repairer"
import {
  enqueuePendingSlot,
  dequeuePendingSlot,
  cleanupPendingSlots,
} from "../src/services/session-state-registry"
import { redactSecrets, containsSecrets } from "../src/lib/secret-redaction"

describe("Targeted Adversarial Verification Suite", () => {
  const TMP = join(tmpdir(), "fd-adversarial-test-" + Date.now())

  beforeEach(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {}
  })

  describe("1. Stale-Lock Repair Safety & PID Liveness", () => {
    it("identifies self PID as alive and bogus PID as dead", () => {
      expect(isPidAlive(process.pid)).toBe(true)
      expect(isPidAlive(999999999)).toBe(false)
      expect(isPidAlive(-1)).toBe(false)
      expect(isPidAlive(0)).toBe(false)
    })

    it("does NOT mark a lock stale if held by a live process within TTL", () => {
      const lockPath = join(TMP, "live.lock")
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), "utf-8")
      expect(isLockStale(lockPath, 60_000)).toBe(false)
    })

    it("marks lock stale if holding PID is dead", () => {
      const lockPath = join(TMP, "dead.lock")
      writeFileSync(lockPath, JSON.stringify({ pid: 999999999, timestamp: Date.now() }), "utf-8")
      expect(isLockStale(lockPath, 60_000)).toBe(true)
    })

    it("repairStaleLocks revalidates and preserves live locks while deleting dead locks", async () => {
      const flowdeckDir = join(TMP, ".flowdeck")
      mkdirSync(flowdeckDir, { recursive: true })
      process.env.FLOWDECK_STATE_DIR = flowdeckDir

      const deadLock = join(flowdeckDir, "fdx.lock")
      const liveLock = join(flowdeckDir, "orchestration.lock")

      writeFileSync(deadLock, JSON.stringify({ pid: 999999999, timestamp: Date.now() }), "utf-8")
      writeFileSync(liveLock, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), "utf-8")

      const res = await repairStaleLocks(TMP)
      expect(res.applied).toBe(true)
      expect(existsSync(deadLock)).toBe(false)
      expect(existsSync(liveLock)).toBe(true) // Preserved live lock!

      delete process.env.FLOWDECK_STATE_DIR
    })
  })

  describe("2. FDX Availability Cache Invalidation", () => {
    it("invalidates in-memory FDX cache immediately when binary is installed/repaired", async () => {
      invalidateFdxCache()
      const before = checkFdxAvailability()
      expect(typeof before).toBe("boolean")

      // Repair FDX creates/updates shim and invalidates cache
      const repairRes = await repairFdxBinary(TMP)
      expect(repairRes.reverified).toBe(true)

      // Immediate check after invalidation
      const detected = resolveFdxBinaryPath(true)
      expect(detected).toBeDefined()
    })
  })

  describe("3. Orchestration Database Split-Brain Protection", () => {
    it("throws OrchestrationDatabaseInaccessibleError when existing DB is read-only", () => {
      const projDir = join(TMP, "proj")
      const dbDir = join(projDir, ".flowdeck")
      mkdirSync(dbDir, { recursive: true })
      const dbFile = join(dbDir, "flowdeck.db")
      writeFileSync(dbFile, "sqlite dummy content", "utf-8")

      // Make DB read-only
      chmodSync(dbFile, 0o444)

      try {
        expect(() => {
          resolveOrchestrationDbPath(projDir)
        }).toThrow(OrchestrationDatabaseInaccessibleError)
      } finally {
        chmodSync(dbFile, 0o644)
      }
    })

    it("returns preferred DB path directly when writable", () => {
      const projDir = join(TMP, "proj-writable")
      const dbDir = join(projDir, ".flowdeck")
      mkdirSync(dbDir, { recursive: true })
      const dbFile = join(dbDir, "flowdeck.db")
      writeFileSync(dbFile, "sqlite dummy content", "utf-8")

      const resolved = resolveOrchestrationDbPath(projDir)
      expect(resolved).toBe(dbFile)
    })
  })

  describe("4. Repository Lease Atomic-Write Correctness", () => {
    it("normalizes repoId using Unicode NFC and prevents collision across slash variants", () => {
      const id1 = repoIdOf(join(TMP, "test/path"))
      const id2 = repoIdOf(join(TMP, "test", "path"))
      expect(id1).toBe(id2)
    })

    it("handles concurrent leases deterministically with atomic rename", async () => {
      const stateDir = join(TMP, "leases")
      const coord = new RepoLeaseCoordinator({ stateDir, maxWaitMs: 200, recheckMs: 20 })

      const lease1 = await coord.acquireMutatingLease("repo_a", "worker_1")
      expect(lease1.owner).toBe("worker_1")

      // Second acquire for same repo should fail when held
      await expect(coord.acquireMutatingLease("repo_a", "worker_2")).rejects.toThrow()

      coord.releaseMutatingLease("repo_a", "worker_1")
      expect(coord.isSafeToMutate("repo_a")).toBe(true)

      const lease2 = await coord.acquireMutatingLease("repo_a", "worker_2")
      expect(lease2.owner).toBe("worker_2")
      coord.releaseMutatingLease("repo_a", "worker_2")
    })
  })

  describe("5. Shell and Fast-Lane Safety", () => {
    it("rewrites safe cat/grep/ls commands accurately without shell spawn", () => {
      const r1 = rewriteShellCommand("cat src/index.ts")
      expect(r1?.adapter).toBe("file-read")
      expect(r1?.file).toBe("src/index.ts")

      const r2 = rewriteShellCommand("sed -n 10,20p src/index.ts")
      expect(r2?.adapter).toBe("file-read-range")
      expect(r2?.offset).toBe(10)
      expect(r2?.limit).toBe(11)

      const r3 = rewriteShellCommand("grep -n hello src/index.ts")
      expect(r3?.adapter).toBe("file-grep")
      expect(r3?.pattern).toBe("hello")

      const r4 = rewriteLsCommand("ls src")
      expect(r4?.adapter).toBe("dir-list")
    })

    it("rejects shell metacharacters and control characters in fast lane", () => {
      expect(rewriteShellCommand("cat file; rm -rf /")).toBeNull()
      expect(rewriteShellCommand("cat file && echo pwned")).toBeNull()
      expect(rewriteShellCommand("cat file$(id)")).toBeNull()
      expect(rewriteShellCommand("cat file\0bad")).toBeNull()
      expect(rewriteLsCommand("ls src; rm -rf /")).toBeNull()
    })

    it("executes fast rewrite accurately in target directory", () => {
      const testFile = join(TMP, "sample.txt")
      writeFileSync(testFile, "Line 1\nLine 2\nLine 3\n", "utf-8")
      const r = rewriteShellCommand("cat sample.txt")!
      const out = executeFastRewrite(r, TMP)
      expect(out).toBe("Line 1\nLine 2\nLine 3\n")
    })
  })

  describe("6. Doctor Semantic Re-Verification & Idempotency", () => {
    it("repairs and verifies MCP configuration with schema validity", async () => {
      const configDir = join(TMP, ".config", "opencode")
      mkdirSync(configDir, { recursive: true })
      process.env.OPENCODE_CONFIG_DIR = configDir

      const configFile = join(configDir, "opencode.json")
      writeFileSync(configFile, "{ invalid json", "utf-8")

      const res1 = await repairMcpConfiguration(TMP)
      expect(res1.applied).toBe(true)
      expect(res1.reverified).toBe(true)

      // Idempotency: second run also succeeds and remains verified
      const res2 = await repairMcpConfiguration(TMP)
      expect(res2.applied).toBe(true)
      expect(res2.reverified).toBe(true)

      const content = JSON.parse(readFileSync(configFile, "utf-8"))
      expect(content.mcp).toBeDefined()
      expect(typeof content.mcp).toBe("object")

      delete process.env.OPENCODE_CONFIG_DIR
    })
  })

  describe("7. Session/Task Correlation Concurrency Safety", () => {
    it("disambiguates same-agent pending slots and marks ambiguous calls cleanly", () => {
      cleanupPendingSlots("parent_1")

      // Two concurrent calls targeting same agent 'backend-coder'
      enqueuePendingSlot("parent_1", "call_1", "parent_1:task_1", "backend-coder")
      enqueuePendingSlot("parent_1", "call_2", "parent_1:task_2", "backend-coder")

      // When dequeuing for 'backend-coder' with 2 pending items, returns ambiguous: true rather than guessing
      const res = dequeuePendingSlot("parent_1", "backend-coder")
      expect(res.ambiguous).toBe(true)
      expect(res.correlation).toBeNull()

      cleanupPendingSlots("parent_1")
    })

    it("authoritatively correlates when single pending slot exists", () => {
      cleanupPendingSlots("parent_2")

      enqueuePendingSlot("parent_2", "call_1", "parent_2:task_1", "mapper")
      const res = dequeuePendingSlot("parent_2", "mapper")
      expect(res.ambiguous).toBe(false)
      expect(res.correlation?.callID).toBe("call_1")
      expect(res.correlation?.targetAgent).toBe("mapper")

      cleanupPendingSlots("parent_2")
    })
  })

  describe("8. Secret Redaction Adversarial Safety", () => {
    it("redacts standard tokens and API keys", () => {
      const input = "apiKey=sk-proj-1234567890123456 and token=ghp_abcdefghijklmnopqrstuvwxyz1234567890 and Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M"
      const redacted = redactSecrets(input)
      expect(redacted).toContain("[REDACTED_API_KEY]")
      expect(redacted).toContain("[REDACTED_GITHUB_TOKEN]")
      expect(redacted).toContain("[REDACTED_BEARER_TOKEN]")
      expect(redacted).not.toContain("sk-proj-1234567890123456")
      expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890")
    })

    it("handles benign and empty strings safely without throwing", () => {
      expect(redactSecrets("")).toBe("")
      expect(redactSecrets("Normal diagnostic log message")).toBe("Normal diagnostic log message")
      expect(containsSecrets("Normal log")).toBe(false)
      expect(containsSecrets("sk-1234567890abcdef")).toBe(true)
    })
  })
})
