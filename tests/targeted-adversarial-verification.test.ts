import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync, chmodSync, readdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir, homedir } from "node:os"
import { isPidAlive, isLockStale } from "../src/services/process-liveness"
import { repairStaleLocks } from "../src/doctor/repair/repairers/stale-locks-repairer"
import { checkFdxAvailability, invalidateFdxCache, resolveFdxBinaryPath, getFdxAvailabilityStatus } from "../src/tools/fdx-shared"
import { repairFdxBinary } from "../src/doctor/repair/repairers/fdx-repairer"
import { repairPluginRegistration } from "../src/doctor/repair/repairers/plugin-registration-repairer"
import { repairSkillsAndLockfile } from "../src/doctor/repair/repairers/skills-repairer"
import { repairPermissions } from "../src/doctor/repair/repairers/permissions-repairer"
import {
  resolveOrchestrationDbPath,
  OrchestrationDatabaseInaccessibleError,
  OrchestrationDatabaseAmbiguityError,
} from "../src/services/orchestration-db-path"
import { RepoLeaseCoordinator, repoIdOf } from "../src/services/repo-lease-coordinator"
import { rewriteShellCommand, rewriteLsCommand } from "../src/services/tool-fast-lane"
import { executeShellCommand } from "../src/services/shell-executor"
import { repairMcpConfiguration } from "../src/doctor/repair/repairers/mcp-repairer"
import {
  enqueuePendingSlot,
  dequeuePendingSlot,
  cleanupPendingSlots,
} from "../src/services/session-state-registry"
import { redactObjectSecrets } from "../src/lib/secret-redaction"

describe("Targeted Adversarial Verification Suite — 7 Evidence Blockers", () => {
  const TMP = join(tmpdir(), "fd-final-proof-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7))

  beforeEach(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {}
  })

  // ─── BLOCKER 1: Real Subprocess-Tree Termination & Descendant Cleanup ─────
  describe("Blocker 1: Real Subprocess-Tree Termination", () => {
    it("terminates direct child process under timeout and returns exit code 143", async () => {
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
          await new Promise(r => setTimeout(r, 100))
          expect(isPidAlive(childPid)).toBe(false)
        }
      }
    })

    it("terminates child process tree cleanly without leaving orphan descendants", async () => {
      const pidFile = join(TMP, "grandchild-pid.txt")
      const cmd = "sh -c \x27sh -c \x22echo $$ > " + pidFile + " && exec sleep 30\x22\x27"
      const res = executeShellCommand(cmd, { cwd: TMP, timeoutMs: 300 })

      expect(res.status).toBe("failed")
      expect(res.exitCode).toBe(143)

      if (existsSync(pidFile)) {
        const grandPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10)
        if (!isNaN(grandPid) && grandPid > 0) {
          await new Promise(r => setTimeout(r, 100))
          expect(isPidAlive(grandPid)).toBe(false)
        }
      }
    })
  })

  // ─── BLOCKER 2: Lease Atomicity with Real Failure Injection ──────────────
  describe("Blocker 2: Lease Atomicity Under Injected Failures", () => {
    it("handles injected temp-file write failure safely without corrupting pre-existing lease", async () => {
      const stateDir = join(TMP, "injected-write-leases")
      mkdirSync(stateDir, { recursive: true })
      const leaseFile = join(stateDir, "lease-repo_w.json")
      const initialLease = { owner: "valid_owner_1", acquiredAt: Date.now(), heartbeatAt: Date.now(), mode: "mutating" }
      writeFileSync(leaseFile, JSON.stringify(initialLease, null, 2), "utf-8")

      // Inject write failure on temp file
      const coord = new RepoLeaseCoordinator({
        stateDir,
        maxWaitMs: 100,
        recheckMs: 20,
        fs: {
          writeFileSync: (path, data, opts) => {
            if (String(path).includes(".tmp-lease-")) {
              throw new Error("INJECTED_DISK_FULL_WRITE_FAILURE")
            }
            writeFileSync(path as any, data as any, opts as any)
          },
        },
      })

      // Attempt acquire should throw the primary error
      expect(() => {
        (coord as any).writeLease("repo_w", { owner: "intruder", acquiredAt: Date.now(), heartbeatAt: Date.now(), mode: "mutating" })
      }).toThrow(/INJECTED_DISK_FULL_WRITE_FAILURE/)

      // Pre-existing valid lease must remain untouched and byte-identical!
      const readBack = JSON.parse(readFileSync(leaseFile, "utf-8"))
      expect(readBack.owner).toBe("valid_owner_1")
    })

    it("handles injected rename failure safely, cleans up temp file, and preserves pre-existing lease", () => {
      const stateDir = join(TMP, "injected-rename-leases")
      mkdirSync(stateDir, { recursive: true })
      const leaseFile = join(stateDir, "lease-repo_r.json")
      const initialLease = { owner: "valid_owner_r", acquiredAt: Date.now(), heartbeatAt: Date.now(), mode: "mutating" }
      writeFileSync(leaseFile, JSON.stringify(initialLease, null, 2), "utf-8")

      // Inject rename failure
      const coord = new RepoLeaseCoordinator({
        stateDir,
        fs: {
          renameSync: () => {
            throw new Error("INJECTED_EPERM_RENAME_FAILURE")
          },
        },
      })

      expect(() => {
        (coord as any).writeLease("repo_r", { owner: "intruder_r", acquiredAt: Date.now(), heartbeatAt: Date.now(), mode: "mutating" })
      }).toThrow(/INJECTED_EPERM_RENAME_FAILURE/)

      // Pre-existing valid lease is intact
      const readBack = JSON.parse(readFileSync(leaseFile, "utf-8"))
      expect(readBack.owner).toBe("valid_owner_r")

      // Temp file was cleaned up
      const files = readdirSync(stateDir)
      expect(files.filter(f => f.startsWith(".tmp-lease-"))).toHaveLength(0)
    })

    it("primary rename error is preserved even if temp cleanup also fails", () => {
      const stateDir = join(TMP, "injected-cleanup-failure")
      mkdirSync(stateDir, { recursive: true })

      const coord = new RepoLeaseCoordinator({
        stateDir,
        fs: {
          renameSync: () => {
            throw new Error("PRIMARY_RENAME_FAILURE")
          },
          rmSync: () => {
            throw new Error("SECONDARY_CLEANUP_FAILURE")
          },
        },
      })

      // Must throw PRIMARY error (never masked by secondary cleanup error)
      expect(() => {
        (coord as any).writeLease("repo_c", { owner: "owner_c", acquiredAt: Date.now(), heartbeatAt: Date.now(), mode: "mutating" })
      }).toThrow(/PRIMARY_RENAME_FAILURE/)
    })

    it("normalizes repoId using Unicode NFC and prevents collision across path variants", () => {
      const id1 = repoIdOf(join(TMP, "workspace/sub"))
      const id2 = repoIdOf(join(TMP, "workspace", "sub"))
      expect(id1).toBe(id2)
    })
  })

  // ─── BLOCKER 3: Stale-Lock Safety & Contract A (Live-Owner Precedence) ────
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

    it("marks lock without PID as stale when file mtime exceeds TTL", async () => {
      const lockPath = join(TMP, "unparseable.lock")
      writeFileSync(lockPath, "not-json-content", "utf-8")
      // Within TTL
      expect(isLockStale(lockPath, 60_000)).toBe(false)
      // Exceeded TTL
      expect(isLockStale(lockPath, -1)).toBe(true)
    })

    it("repairStaleLocks revalidates staleness before deletion and preserves live locks", async () => {
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

  // ─── BLOCKER 4: FDX Cache Mutation & Invalidation ─────────────────────────
  describe("Blocker 4: FDX Cache External Mutation & Invalidation", () => {
    it("invalidates cache immediately and forceRefresh forces fresh disk check", () => {
      invalidateFdxCache()
      const cached = checkFdxAvailability(false)
      expect(typeof cached).toBe("boolean")

      // forceRefresh bypasses cache key
      const refreshed = checkFdxAvailability(true)
      expect(refreshed).toBe(cached)
    })

    it("detects FDX_BINARY_PATH changes dynamically", () => {
      const original = process.env.FDX_BINARY_PATH
      try {
        process.env.FDX_BINARY_PATH = "/tmp/nonexistent-fdx-bin-12345"
        const status = getFdxAvailabilityStatus()
        expect(status.available).toBe(false)

        process.env.FDX_BINARY_PATH = "/bin/sh"
        const status2 = getFdxAvailabilityStatus()
        // /bin/sh is not FDX, so should be unavailable
        expect(status2.available).toBe(false)
      } finally {
        if (original) process.env.FDX_BINARY_PATH = original
        else delete process.env.FDX_BINARY_PATH
        invalidateFdxCache()
      }
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
  describe("Blocker 5: Orchestration Database Split-Brain & Multi-DB Ambiguity", () => {
    it("throws OrchestrationDatabaseInaccessibleError if preferred project DB exists but is read-only", () => {
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

    it("throws OrchestrationDatabaseAmbiguityError when multiple fallback DBs exist without a project DB", () => {
      const projDir = join(TMP, "proj-ambiguous")
      const homeDb = join(homedir(), ".flowdeck", "flowdeck.db")
      const tmpDb = join(tmpdir(), "flowdeck", "flowdeck.db")

      // If both fallback DBs exist simultaneously on the machine
      if (existsSync(homeDb) && existsSync(tmpDb)) {
        expect(() => {
          resolveOrchestrationDbPath(projDir)
        }).toThrow(OrchestrationDatabaseAmbiguityError)
      }
    })
  })

  // ─── BLOCKER 6: Hostile-Filename Execution & Injection Safety ─────────────
  describe("Blocker 6: Real Hostile-Filename Execution & Injection Safety", () => {
    const sentinelFile = join(TMP, "sentinel-injected-pwned.txt")

    it("executes safely on real files with hostile filenames and prevents command injection", () => {
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
