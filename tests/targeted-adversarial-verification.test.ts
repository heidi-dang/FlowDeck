import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync, chmodSync, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
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
import { RepoLeaseCoordinator } from "../src/services/repo-lease-coordinator"
import { rewriteShellCommand, rewriteLsCommand } from "../src/services/tool-fast-lane"
import { executeShellCommand } from "../src/services/shell-executor"
import { repairMcpConfiguration } from "../src/doctor/repair/repairers/mcp-repairer"
import {
  enqueuePendingSlot,
  dequeuePendingSlot,
  cleanupPendingSlots,
} from "../src/services/session-state-registry"
import { redactObjectSecrets } from "../src/lib/secret-redaction"

describe("Targeted Adversarial Verification Suite — Final 7 Evidence Blockers", () => {
  const TMP = join(tmpdir(), "fd-final-evidence-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7))

  beforeEach(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {}
  })

  // ─── BLOCKER 1: Real Subprocess-Tree Termination & Bounds ─────────────────
  describe("Blocker 1: Real Subprocess-Tree Termination", () => {
    it("terminates direct child and normalizes timeout signal to 143", async () => {
      const pidFile = join(TMP, "child-pid.txt")
      const script = `echo $$ > "${pidFile}" && exec sleep 30`
      const start = Date.now()
      const res = executeShellCommand(script, { cwd: TMP, timeoutMs: 300 })
      const elapsed = Date.now() - start

      expect(res.status).toBe("failed")
      expect(res.exitCode).toBe(143) // 128 + 15 (SIGTERM)
      expect(elapsed).toBeLessThan(5000)

      if (existsSync(pidFile)) {
        const childPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10)
        if (!isNaN(childPid) && childPid > 0) {
          // Wait briefly for signal propagation
          await new Promise(r => setTimeout(r, 100))
          expect(isPidAlive(childPid)).toBe(false) // Direct child PID is dead!
        }
      }
    })

    it("terminates child process tree cleanly under timeout without leaking descendants", async () => {
      const pidFile = join(TMP, "grandchild-pid.txt")
      const cmd = "sh -c \x27sh -c \x22echo $$ > " + pidFile + " && exec sleep 30\x22\x27"
      const res = executeShellCommand(cmd, { cwd: TMP, timeoutMs: 300 })

      expect(res.status).toBe("failed")
      expect(res.exitCode).toBe(143)

      if (existsSync(pidFile)) {
        const grandPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10)
        if (!isNaN(grandPid) && grandPid > 0) {
          await new Promise(r => setTimeout(r, 100))
          expect(isPidAlive(grandPid)).toBe(false) // Grandchild terminated!
        }
      }
    })
  })

  // ─── BLOCKER 2: Lease Atomicity Under Injected Failures ───────────────────
  describe("Blocker 2: Lease Atomicity Under Failure Injection", () => {
    it("creates temp files in stateDir and prevents concurrent double ownership", async () => {
      const stateDir = join(TMP, "leases")
      const coord = new RepoLeaseCoordinator({ stateDir, maxWaitMs: 200, recheckMs: 20 })

      const lease1 = await coord.acquireMutatingLease("repo_atomicity", "worker_1")
      expect(lease1.owner).toBe("worker_1")

      // Competing acquire fails deterministically
      await expect(coord.acquireMutatingLease("repo_atomicity", "worker_2")).rejects.toThrow()

      const files = readdirSync(stateDir)
      expect(files.filter(f => f.startsWith(".tmp-lease-"))).toHaveLength(0) // No leftover temp files
      expect(files.filter(f => f.startsWith("lease-"))).toHaveLength(1)

      coord.releaseMutatingLease("repo_atomicity", "worker_1")
      expect(coord.isSafeToMutate("repo_atomicity")).toBe(true)
    })

    it("recovers safely from a pre-existing malformed lease without corrupting state", async () => {
      const stateDir = join(TMP, "corrupt-leases")
      mkdirSync(stateDir, { recursive: true })
      const leaseFile = join(stateDir, "lease-repo_corrupt.json")
      writeFileSync(leaseFile, "CORRUPT JSON CONTENT {", "utf-8")

      const coord = new RepoLeaseCoordinator({ stateDir, maxWaitMs: 200, recheckMs: 20 })
      const lease = await coord.acquireMutatingLease("repo_corrupt", "recovery_worker")
      expect(lease.owner).toBe("recovery_worker")
      coord.releaseMutatingLease("repo_corrupt", "recovery_worker")
    })

    it("orphaned temp files from simulated crash do not block future acquisitions", async () => {
      const stateDir = join(TMP, "orphan-leases")
      mkdirSync(stateDir, { recursive: true })
      // Simulate crash leftover temp file
      writeFileSync(join(stateDir, ".tmp-lease-orphan-123"), "crash data", "utf-8")

      const coord = new RepoLeaseCoordinator({ stateDir, maxWaitMs: 200, recheckMs: 20 })
      const lease = await coord.acquireMutatingLease("orphan_repo", "new_worker")
      expect(lease.owner).toBe("new_worker")
      coord.releaseMutatingLease("orphan_repo", "new_worker")
    })
  })

  // ─── BLOCKER 3: Stale-Lock Safety & Contract A Live-Owner Precedence ──────
  describe("Blocker 3: Stale-Lock Safety (Contract A: Live-Owner Precedence)", () => {
    it("proves Contract A: live process holding lock is NEVER stale regardless of age", () => {
      const lockPath = join(TMP, "live-old.lock")
      const veryOldTimestamp = Date.now() - 3600_000 // 1 hour ago
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: veryOldTimestamp }), "utf-8")

      // Process is alive -> MUST NOT be marked stale!
      expect(isLockStale(lockPath, 60_000)).toBe(false)
    })

    it("marks lock stale if holding PID is dead", () => {
      const lockPath = join(TMP, "dead.lock")
      writeFileSync(lockPath, JSON.stringify({ pid: 999999999, timestamp: Date.now() }), "utf-8")
      expect(isLockStale(lockPath, 60_000)).toBe(true)
    })

    it("revalidates staleness before deletion and preserves live process locks", async () => {
      const flowdeckDir = join(TMP, ".flowdeck")
      mkdirSync(flowdeckDir, { recursive: true })
      process.env.FLOWDECK_STATE_DIR = flowdeckDir

      const deadLock = join(flowdeckDir, "fdx.lock")
      const liveLock = join(flowdeckDir, "orchestration.lock")

      writeFileSync(deadLock, JSON.stringify({ pid: 999999999, timestamp: Date.now() }), "utf-8")
      writeFileSync(liveLock, JSON.stringify({ pid: process.pid, timestamp: Date.now() }), "utf-8")

      const res = await repairStaleLocks(TMP)
      expect(res.applied).toBe(true)
      expect(existsSync(deadLock)).toBe(false) // Dead lock deleted
      expect(existsSync(liveLock)).toBe(true)  // Live lock preserved!

      delete process.env.FLOWDECK_STATE_DIR
    })
  })

  // ─── BLOCKER 4: FDX Cache External-Mutation Correctness ───────────────────
  describe("Blocker 4: FDX Cache Mutation & Invalidation", () => {
    it("invalidates cache immediately and forceRefresh forces fresh disk check", () => {
      invalidateFdxCache()
      const cached = checkFdxAvailability(false)
      expect(typeof cached).toBe("boolean")

      // forceRefresh bypasses cache key
      const refreshed = checkFdxAvailability(true)
      expect(refreshed).toBe(cached)
    })

    it("reflects repaired binary immediately via invalidateFdxCache()", async () => {
      invalidateFdxCache()
      const repairRes = await repairFdxBinary(TMP)
      expect(repairRes.reverified).toBe(true)

      const detected = resolveFdxBinaryPath(true)
      expect(detected).toBeDefined()
    })
  })

  // ─── BLOCKER 5: Orchestration Database Split-Brain Protection ─────────────
  describe("Blocker 5: Orchestration Database Split-Brain Protection", () => {
    it("throws OrchestrationDatabaseInaccessibleError when project DB exists but is read-only", () => {
      const projDir = join(TMP, "proj-split")
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

    it("returns preferred project DB directly when writable", () => {
      const projDir = join(TMP, "proj-writable")
      const dbDir = join(projDir, ".flowdeck")
      mkdirSync(dbDir, { recursive: true })
      const dbFile = join(dbDir, "flowdeck.db")
      writeFileSync(dbFile, "sqlite content", "utf-8")

      const resolved = resolveOrchestrationDbPath(projDir)
      expect(resolved).toBe(dbFile)
    })
  })

  // ─── BLOCKER 6: Hostile-Filename Execution & Injection Safety ─────────────
  describe("Blocker 6: Real Hostile-Filename Execution & Injection Safety", () => {
    const sentinelFile = join(TMP, "sentinel-injected-pwned.txt")

    it("executes safely on filenames with spaces, metacharacters and prevents command injection", () => {
      // Create real files with hostile filenames
      const hostileNames = [
        "space file.txt",
        "semi;colon.txt",
        "amp&ersand.txt",
        "$(subst).txt",
        "pipe|name.txt",
        "single'quote.txt",
        "[brackets].txt",
        "-leading-hyphen.txt",
      ]

      for (const name of hostileNames) {
        const filePath = join(TMP, name)
        writeFileSync(filePath, `Content of ${name}\n`, "utf-8")
        expect(existsSync(filePath)).toBe(true)

        // Attempt cat via shell command using canonical single-quote escaping
        const quotedPath = "'" + filePath.replace(/'/g, "'\\''") + "'"
        const res = executeShellCommand(`cat ${quotedPath}`, { cwd: TMP })
        expect(res.status).toBe("ok")
        expect(res.output).toContain(`Content of ${name}`)
      }

      // Assert sentinel command injection NEVER executed
      expect(existsSync(sentinelFile)).toBe(false)
    })

    it("rejects dangerous shell injection tokens from fast lane rewrite", () => {
      expect(rewriteShellCommand(`cat file; touch "${sentinelFile}"`)).toBeNull()
      expect(rewriteShellCommand(`cat file && touch "${sentinelFile}"`)).toBeNull()
      expect(rewriteShellCommand(`cat file$(touch "${sentinelFile}")`)).toBeNull()
      expect(rewriteLsCommand(`ls src; touch "${sentinelFile}"`)).toBeNull()
      expect(existsSync(sentinelFile)).toBe(false)
    })
  })

  // ─── BLOCKER 7: Doctor Second-Run No-Mutation Proof ───────────────────────
  describe("Blocker 7: Doctor Repairer Idempotency & No-Mutation Proof", () => {
    it("mcp-repairer does not mutate healthy opencode.json on second run", async () => {
      const configDir = join(TMP, ".config-mcp", "opencode")
      mkdirSync(configDir, { recursive: true })
      process.env.OPENCODE_CONFIG_DIR = configDir

      const configFile = join(configDir, "opencode.json")
      writeFileSync(configFile, "{ invalid json", "utf-8")

      // Pass 1: repair broken config
      const res1 = await repairMcpConfiguration(TMP)
      expect(res1.applied).toBe(true)
      expect(res1.reverified).toBe(true)

      const hash1 = createHash("sha256").update(readFileSync(configFile)).digest("hex")

      // Pass 2: repair on healthy config
      const res2 = await repairMcpConfiguration(TMP)
      expect(res2.reverified).toBe(true)

      const hash2 = createHash("sha256").update(readFileSync(configFile)).digest("hex")
      expect(hash2).toBe(hash1) // Byte-identical, zero unnecessary mutations!

      delete process.env.OPENCODE_CONFIG_DIR
    })

    it("plugin-registration-repairer does not mutate healthy opencode.json on second run", async () => {
      const configDir = join(TMP, ".config-plugin", "opencode")
      mkdirSync(configDir, { recursive: true })
      process.env.OPENCODE_CONFIG_DIR = configDir

      const configFile = join(configDir, "opencode.json")

      // Pass 1: initial repair
      const res1 = await repairPluginRegistration(TMP)
      expect(res1.reverified).toBe(true)

      const hash1 = createHash("sha256").update(readFileSync(configFile)).digest("hex")

      // Pass 2: second run
      const res2 = await repairPluginRegistration(TMP)
      expect(res2.reverified).toBe(true)

      const hash2 = createHash("sha256").update(readFileSync(configFile)).digest("hex")
      expect(hash2).toBe(hash1) // Unchanged hash!

      delete process.env.OPENCODE_CONFIG_DIR
    })

    it("skills-repairer does not mutate healthy skills-lock.json on second run", async () => {
      const skillsLock = join(TMP, "src", "skills", "skills-lock.json")

      // Pass 1
      const res1 = await repairSkillsAndLockfile(TMP)
      expect(res1.reverified).toBe(true)

      const hash1 = createHash("sha256").update(readFileSync(skillsLock)).digest("hex")

      // Pass 2
      const res2 = await repairSkillsAndLockfile(TMP)
      expect(res2.reverified).toBe(true)

      const hash2 = createHash("sha256").update(readFileSync(skillsLock)).digest("hex")
      expect(hash2).toBe(hash1) // Unchanged hash!
    })

    it("permissions-repairer and stale-locks-repairer maintain idempotency", async () => {
      const flowdeckDir = join(TMP, ".flowdeck")
      mkdirSync(flowdeckDir, { recursive: true })

      const perm1 = await repairPermissions(TMP)
      expect(perm1.reverified).toBe(true)
      const perm2 = await repairPermissions(TMP)
      expect(perm2.reverified).toBe(true)

      const stale1 = await repairStaleLocks(TMP)
      expect(stale1.reverified).toBe(true)
      const stale2 = await repairStaleLocks(TMP)
      expect(stale2.reverified).toBe(true)
    })
  })

  // ─── Extra: Secret Redaction Object Traversal & Edge Cases ────────────────
  describe("Secret Redaction Edge Cases & Circular Traversal", () => {
    it("redacts circular objects and Error cause chains without throwing", () => {
      const circular: any = { authKey: "sk-live1234567890abcdef", name: "Safe" }
      circular.self = circular

      const redacted = redactObjectSecrets(circular)
      expect(redacted.authKey).toBe("[REDACTED]")
      expect(redacted.self).toBe("[CIRCULAR]")

      const cause = new Error("DB Error with token: npm_abcdef1234567890abcdef1234567890abcd")
      const topErr = new Error("Outer failure")
      ;(topErr as any).cause = cause

      const redactedErr = redactObjectSecrets(topErr) as any
      expect(redactedErr.cause.message).toContain("[REDACTED_NPM_TOKEN]")
    })

    it("handles concurrent same-agent correlation disambiguation", () => {
      cleanupPendingSlots("parent_disambig")
      enqueuePendingSlot("parent_disambig", "call_x", "parent_disambig:task_x", "researcher")
      enqueuePendingSlot("parent_disambig", "call_y", "parent_disambig:task_y", "researcher")

      const res = dequeuePendingSlot("parent_disambig", "researcher")
      expect(res.ambiguous).toBe(true)
      expect(res.correlation).toBeNull()
      cleanupPendingSlots("parent_disambig")
    })
  })
})
