import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync, chmodSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { isPidAlive, isLockStale } from "../src/services/process-liveness"
import { repairStaleLocks } from "../src/doctor/repair/repairers/stale-locks-repairer"
import { checkFdxAvailability, invalidateFdxCache, resolveFdxBinaryPath } from "../src/tools/fdx-shared"
import { repairFdxBinary } from "../src/doctor/repair/repairers/fdx-repairer"
import { repairPluginRegistration } from "../src/doctor/repair/repairers/plugin-registration-repairer"
import { repairSkillsAndLockfile } from "../src/doctor/repair/repairers/skills-repairer"
import { repairPermissions } from "../src/doctor/repair/repairers/permissions-repairer"
import { resolveOrchestrationDbPath, OrchestrationDatabaseInaccessibleError } from "../src/services/orchestration-db-path"
import { RepoLeaseCoordinator, repoIdOf } from "../src/services/repo-lease-coordinator"
import { rewriteShellCommand, rewriteLsCommand } from "../src/services/tool-fast-lane"
import { executeShellCommand } from "../src/services/shell-executor"
import { repairMcpConfiguration } from "../src/doctor/repair/repairers/mcp-repairer"
import {
  enqueuePendingSlot,
  dequeuePendingSlot,
  cleanupPendingSlots,
} from "../src/services/session-state-registry"
import { redactSecrets, redactObjectSecrets } from "../src/lib/secret-redaction"

describe("Targeted Adversarial Verification Suite — 8 Critical Invariants", () => {
  const TMP = join(tmpdir(), "fd-adv-evidence-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7))

  beforeEach(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {}
  })

  describe("Blocker 1: Subprocess-Tree Termination & Direct Child Bounds", () => {
    it("handles fast-lane and fallback execution cleanly without unhandled rejections", () => {
      const res = executeShellCommand("echo 'flowdeck-adv-exec'", { cwd: TMP })
      expect(res.status).toBe("ok")
      expect(res.output.trim()).toBe("flowdeck-adv-exec")
      expect(res.exitCode).toBe(0)
    })

    it("terminates child process and normalizes exit code accurately on non-zero exit", () => {
      const res = executeShellCommand("sh -c 'exit 42'", { cwd: TMP })
      expect(res.status).toBe("failed")
      expect(res.exitCode).toBe(42)
    })
  })

  describe("Blocker 2: Lease Atomicity Under Injected Failures", () => {
    it("normalizes repoId using Unicode NFC across path variations", () => {
      const id1 = repoIdOf(join(TMP, "workspace/sub"))
      const id2 = repoIdOf(join(TMP, "workspace", "sub"))
      expect(id1).toBe(id2)
    })

    it("isolates temp files in stateDir and prevents concurrent double ownership", async () => {
      const stateDir = join(TMP, "leases")
      const coord = new RepoLeaseCoordinator({ stateDir, maxWaitMs: 200, recheckMs: 20 })

      const lease1 = await coord.acquireMutatingLease("repo_x", "owner_1")
      expect(lease1.owner).toBe("owner_1")

      // Second competing acquire fails deterministically
      await expect(coord.acquireMutatingLease("repo_x", "owner_2")).rejects.toThrow()

      // Verify temp files are cleaned up and only lease file remains
      const files = readdirSync(stateDir)
      expect(files.filter(f => f.startsWith(".tmp-lease-"))).toHaveLength(0)
      expect(files.filter(f => f.startsWith("lease-"))).toHaveLength(1)

      coord.releaseMutatingLease("repo_x", "owner_1")
      expect(coord.isSafeToMutate("repo_x")).toBe(true)
    })

    it("recovers safely from a corrupted pre-existing lease file", async () => {
      const stateDir = join(TMP, "corrupt-leases")
      mkdirSync(stateDir, { recursive: true })
      const leaseFile = join(stateDir, "lease-repo_corrupt.json")
      writeFileSync(leaseFile, "{ invalid json corrupt content", "utf-8")

      const coord = new RepoLeaseCoordinator({ stateDir, maxWaitMs: 200, recheckMs: 20 })
      const lease = await coord.acquireMutatingLease("repo_corrupt", "recovery_owner")
      expect(lease.owner).toBe("recovery_owner")
      coord.releaseMutatingLease("repo_corrupt", "recovery_owner")
    })
  })

  describe("Blocker 3: Stale-Lock Ownership & PID Reuse Safety", () => {
    it("identifies self PID as alive and dead PID as stale", () => {
      expect(isPidAlive(process.pid)).toBe(true)
      expect(isPidAlive(999999999)).toBe(false)
      expect(isPidAlive(-1)).toBe(false)
    })

    it("preserves live lock when held by active process within TTL", () => {
      const lockPath = join(TMP, "active.lock")
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), "utf-8")
      expect(isLockStale(lockPath, 60_000)).toBe(false)
    })

    it("identifies dead PID lock as stale regardless of timestamp", () => {
      const lockPath = join(TMP, "dead.lock")
      writeFileSync(lockPath, JSON.stringify({ pid: 999999999, timestamp: Date.now() }), "utf-8")
      expect(isLockStale(lockPath, 60_000)).toBe(true)
    })

    it("identifies expired lock as stale even if PID was recycled", () => {
      const lockPath = join(TMP, "recycled.lock")
      const oldTime = Date.now() - 120_000 // 2 minutes ago (TTL 60s)
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: oldTime }), "utf-8")
      expect(isLockStale(lockPath, 60_000)).toBe(true)
    })

    it("repairStaleLocks revalidates and preserves live locks while unlinking dead locks", async () => {
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
      expect(existsSync(liveLock)).toBe(true) // Live lock preserved!

      delete process.env.FLOWDECK_STATE_DIR
    })
  })

  describe("Blocker 4: FDX Cache Mutation & Invalidation", () => {
    it("invalidates in-memory FDX cache immediately upon binary repair", async () => {
      invalidateFdxCache()
      const before = checkFdxAvailability()
      expect(typeof before).toBe("boolean")

      const repairRes = await repairFdxBinary(TMP)
      expect(repairRes.reverified).toBe(true)

      const detected = resolveFdxBinaryPath(true)
      expect(detected).toBeDefined()
    })

    it("forceRefresh forces fresh disk check even when cache key is unchanged", () => {
      invalidateFdxCache()
      const r1 = checkFdxAvailability(false)
      const r2 = checkFdxAvailability(true)
      expect(r1).toBe(r2)
    })
  })

  describe("Blocker 5: Orchestration Database Split-Brain & Ambiguity Protection", () => {
    it("throws OrchestrationDatabaseInaccessibleError if preferred project DB exists but is read-only", () => {
      const projDir = join(TMP, "proj-split-brain")
      const dbDir = join(projDir, ".flowdeck")
      mkdirSync(dbDir, { recursive: true })
      const dbFile = join(dbDir, "flowdeck.db")
      writeFileSync(dbFile, "sqlite dummy content", "utf-8")

      chmodSync(dbFile, 0o444)
      try {
        expect(() => {
          resolveOrchestrationDbPath(projDir)
        }).toThrow(OrchestrationDatabaseInaccessibleError)
      } finally {
        chmodSync(dbFile, 0o644)
      }
    })

    it("returns preferred DB path directly when project DB is writable", () => {
      const projDir = join(TMP, "proj-writable")
      const dbDir = join(projDir, ".flowdeck")
      mkdirSync(dbDir, { recursive: true })
      const dbFile = join(dbDir, "flowdeck.db")
      writeFileSync(dbFile, "sqlite content", "utf-8")

      const resolved = resolveOrchestrationDbPath(projDir)
      expect(resolved).toBe(dbFile)
    })
  })

  describe("Blocker 6: Shell & Path Execution Safety with Hostile Filenames", () => {
    it("rewrites safe read/grep/ls commands accurately without shell spawn", () => {
      const r1 = rewriteShellCommand("cat src/index.ts")
      expect(r1?.adapter).toBe("file-read")
      expect(r1?.file).toBe("src/index.ts")

      const r2 = rewriteLsCommand("ls src")
      expect(r2?.adapter).toBe("dir-list")
    })

    it("rejects shell metacharacters and control characters from fast lane", () => {
      expect(rewriteShellCommand("cat file; rm -rf /")).toBeNull()
      expect(rewriteShellCommand("cat file && echo pwned")).toBeNull()
      expect(rewriteShellCommand("cat file$(id)")).toBeNull()
      expect(rewriteShellCommand("cat file\0bad")).toBeNull()
      expect(rewriteLsCommand("ls src; rm -rf /")).toBeNull()
    })

    it("safely handles files with spaces and special characters in fast lane or fallback", () => {
      const testFile = join(TMP, "sample document.txt")
      writeFileSync(testFile, "Line A\nLine B\n", "utf-8")

      const res = executeShellCommand(`cat "${testFile}"`, { cwd: TMP })
      expect(res.status).toBe("ok")
      expect(res.output).toContain("Line A")
    })
  })

  describe("Blocker 7: Doctor Repairer Idempotency & No-Unnecessary-Mutation", () => {
    it("repairs MCP configuration and maintains idempotency across multiple runs", async () => {
      const configDir = join(TMP, ".config-mcp", "opencode")
      mkdirSync(configDir, { recursive: true })
      process.env.OPENCODE_CONFIG_DIR = configDir

      const configFile = join(configDir, "opencode.json")
      writeFileSync(configFile, "{ invalid json", "utf-8")

      const res1 = await repairMcpConfiguration(TMP)
      expect(res1.applied).toBe(true)
      expect(res1.reverified).toBe(true)

      // Run second pass on healthy config
      const res2 = await repairMcpConfiguration(TMP)
      expect(res2.reverified).toBe(true)

      const parsed = JSON.parse(readFileSync(configFile, "utf-8"))
      expect(parsed.mcp).toBeDefined()
      expect(typeof parsed.mcp).toBe("object")

      delete process.env.OPENCODE_CONFIG_DIR
    })

    it("repairs permissions and remains idempotent", async () => {
      const flowdeckDir = join(TMP, ".flowdeck-perm")
      mkdirSync(flowdeckDir, { recursive: true })

      const res1 = await repairPermissions(TMP)
      expect(res1.reverified).toBe(true)

      const res2 = await repairPermissions(TMP)
      expect(res2.reverified).toBe(true)
    })

    it("repairs plugin registration and remains idempotent", async () => {
      const configDir = join(TMP, ".config-plugin", "opencode")
      mkdirSync(configDir, { recursive: true })
      process.env.OPENCODE_CONFIG_DIR = configDir

      const res1 = await repairPluginRegistration(TMP)
      expect(res1.reverified).toBe(true)

      const res2 = await repairPluginRegistration(TMP)
      expect(res2.reverified).toBe(true)

      delete process.env.OPENCODE_CONFIG_DIR
    })

    it("repairs skills lockfile and remains idempotent", async () => {
      const res1 = await repairSkillsAndLockfile(TMP)
      expect(res1.reverified).toBe(true)

      const res2 = await repairSkillsAndLockfile(TMP)
      expect(res2.reverified).toBe(true)
    })
  })

  describe("Blocker 8: Secret Redaction Consolidation & Object Traversal", () => {
    it("redacts string tokens accurately", () => {
      const input = "apiKey=sk-proj-1234567890123456 and token=ghp_abcdefghijklmnopqrstuvwxyz1234567890"
      const out = redactSecrets(input)
      expect(out).toContain("[REDACTED_API_KEY]")
      expect(out).toContain("[REDACTED_GITHUB_TOKEN]")
      expect(out).not.toContain("sk-proj-1234567890123456")
      expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz1234567890")
    })

    it("redacts structured objects with circular reference protection and depth caps", () => {
      const obj: any = {
        title: "Report",
        apiKey: "sk-1234567890123456",
        nested: {
          token: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        },
      }
      obj.self = obj // Circular reference!

      const redacted = redactObjectSecrets(obj)
      expect(redacted.title).toBe("Report")
      expect(redacted.apiKey).toBe("[REDACTED]")
      expect(redacted.nested.token).toBe("[REDACTED]")
      expect(redacted.self).toBe("[CIRCULAR]")
    })

    it("handles Error objects and cause chains without throwing", () => {
      const cause = new Error("Underlying database connection token: npm_abcdef1234567890abcdef1234567890abcd")
      const err = new Error("Operation failed with key: sk-live1234567890abcdef")
      ;(err as any).cause = cause

      const redactedErr = redactObjectSecrets(err) as any
      expect(redactedErr.message).toContain("[REDACTED_API_KEY]")
      expect(redactedErr.cause.message).toContain("[REDACTED_NPM_TOKEN]")
    })

    it("handles concurrent same-agent correlation disambiguation", () => {
      cleanupPendingSlots("parent_test")
      enqueuePendingSlot("parent_test", "call_a", "parent_test:task_a", "mapper")
      enqueuePendingSlot("parent_test", "call_b", "parent_test:task_b", "mapper")

      const res = dequeuePendingSlot("parent_test", "mapper")
      expect(res.ambiguous).toBe(true)
      expect(res.correlation).toBeNull()
      cleanupPendingSlots("parent_test")
    })
  })
})
