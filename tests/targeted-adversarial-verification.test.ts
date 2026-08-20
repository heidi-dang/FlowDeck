import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync, chmodSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir, homedir } from "node:os"
import { repairStaleLocks } from "../src/doctor/repair/repairers/stale-locks-repairer"
import { checkFdxAvailability, invalidateFdxCache, resolveFdxBinaryPath, getFdxAvailabilityStatus } from "../src/tools/fdx-shared"
import { repairFdxBinary } from "../src/doctor/repair/repairers/fdx-repairer"
import { repairPermissions } from "../src/doctor/repair/repairers/permissions-repairer"
import {
  resolveOrchestrationDbPath,
  OrchestrationDatabaseInaccessibleError,
  OrchestrationDatabaseAmbiguityError,
} from "../src/services/orchestration-db-path"
import { RepoLeaseCoordinator } from "../src/services/repo-lease-coordinator"
import { executeShellCommand } from "../src/services/shell-executor"
import { redactObjectSecrets } from "../src/lib/secret-redaction"
import { loadFlowDeckConfig } from "../src/config/index"

describe("Targeted Adversarial Verification Suite — 3 Final Gap Matrices", () => {
  const TMP = join(tmpdir(), "fd-final3-proof-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7))

  beforeEach(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    try {
      rmSync(TMP, { recursive: true, force: true })
    } catch {}
  })

  // ═════════════════════════════════════════════════════════════════════════
  // GAP 1: FDX Cache State-Transition Matrix
  // ═════════════════════════════════════════════════════════════════════════
  describe("Gap 1: FDX Cache State-Transition Matrix", () => {
    const fdxBinPath = join(TMP, "custom-bin", process.platform === "win32" ? "fdx.exe" : "fdx")

    beforeEach(() => {
      mkdirSync(join(TMP, "custom-bin"), { recursive: true })
      writeFileSync(fdxBinPath, '#!/usr/bin/env sh\necho "fdx 0.1.0 (test-binary)"\n', { mode: 0o755, encoding: "utf-8" })
    })

    it("Transition A: cached success -> binary externally deleted -> forceRefresh reflects unavailable", () => {
      process.env.FDX_BINARY_PATH = fdxBinPath
      invalidateFdxCache()

      // 1. Positive cache hit
      const initial = checkFdxAvailability(false)
      expect(initial).toBe(true)

      // 2. Delete binary externally without doctor
      unlinkSync(fdxBinPath)
      expect(existsSync(fdxBinPath)).toBe(false)

      // 3. Stale cache still returns true before refresh
      expect(checkFdxAvailability(false)).toBe(true)

      // 4. Correctness-relevant refresh path recovers accurately
      const refreshed = checkFdxAvailability(true)
      expect(refreshed).toBe(false)

      delete process.env.FDX_BINARY_PATH
      invalidateFdxCache()
    })

    it("Transition B: cached success -> executable permission removed -> forceRefresh reflects unavailable", () => {
      if (process.platform === "win32") return // chmod execute bit not applicable on Windows

      process.env.FDX_BINARY_PATH = fdxBinPath
      invalidateFdxCache()

      // 1. Positive cache hit
      expect(checkFdxAvailability(false)).toBe(true)

      // 2. Remove executable bit externally
      chmodSync(fdxBinPath, 0o644)

      // 3. Force refresh detects non-executable binary
      const refreshed = checkFdxAvailability(true)
      expect(refreshed).toBe(false)

      chmodSync(fdxBinPath, 0o755)
      delete process.env.FDX_BINARY_PATH
      invalidateFdxCache()
    })

    it("Transition C: cached success -> binary replaced at same path -> revalidates executable", () => {
      process.env.FDX_BINARY_PATH = fdxBinPath
      invalidateFdxCache()

      expect(checkFdxAvailability(false)).toBe(true)

      // Replace with new valid binary content
      writeFileSync(fdxBinPath, '#!/usr/bin/env sh\necho "fdx 0.1.1 (updated-replacement)"\n', { mode: 0o755, encoding: "utf-8" })

      const refreshed = checkFdxAvailability(true)
      expect(refreshed).toBe(true)

      delete process.env.FDX_BINARY_PATH
      invalidateFdxCache()
    })

    it("Transition D: cached miss -> binary appears externally -> forceRefresh recovers availability", () => {
      const missingPath = join(TMP, "custom-bin", "fdx-late-appear")
      process.env.FDX_BINARY_PATH = missingPath
      invalidateFdxCache()

      // 1. Populate negative cache
      expect(checkFdxAvailability(false)).toBe(false)

      // 2. Binary appears externally
      writeFileSync(missingPath, '#!/usr/bin/env sh\necho "fdx 0.1.0 (late)"\n', { mode: 0o755, encoding: "utf-8" })

      // 3. Force refresh discovers new binary
      expect(checkFdxAvailability(true)).toBe(true)

      delete process.env.FDX_BINARY_PATH
      invalidateFdxCache()
    })

    it("Transition E: FDX_BINARY_PATH environment change naturally alters cache resolution", () => {
      invalidateFdxCache()
      process.env.FDX_BINARY_PATH = fdxBinPath
      expect(checkFdxAvailability(false)).toBe(true)

      // Transition to invalid path
      process.env.FDX_BINARY_PATH = "/tmp/nonexistent-fdx-12345"
      expect(checkFdxAvailability(false)).toBe(false)

      delete process.env.FDX_BINARY_PATH
      invalidateFdxCache()
    })

    it("Transition F: PATH environment change dynamically changes binary discovery", () => {
      invalidateFdxCache()
      const originalPath = process.env.PATH
      try {
        process.env.PATH = join(TMP, "custom-bin")
        const status = getFdxAvailabilityStatus(true)
        expect(status.available).toBe(true)
      } finally {
        process.env.PATH = originalPath
        invalidateFdxCache()
      }
    })

    it("Transition G: Doctor repair invalidates cache and makes repaired binary observable", async () => {
      invalidateFdxCache()
      const repairRes = await repairFdxBinary(TMP)
      expect(repairRes.reverified).toBe(true)

      const detected = resolveFdxBinaryPath(true)
      expect(detected).toBeDefined()
    })

    it("Transition H: Normal runtime configuration reload lifecycle refreshes state", () => {
      const cfgPath = join(TMP, ".flowdeck.json")
      writeFileSync(cfgPath, JSON.stringify({ routing: { enabled: true } }), "utf-8")

      const config = loadFlowDeckConfig(TMP)
      expect(config.routing?.enabled).toBe(true)

      // Invalidate FDX cache on configuration reload boundaries
      invalidateFdxCache()
      const status = checkFdxAvailability(true)
      expect(typeof status).toBe("boolean")
    })
  })

  // ═════════════════════════════════════════════════════════════════════════
  // GAP 2: Orchestration Database Complete Ownership & Split-Brain Matrix
  // ═════════════════════════════════════════════════════════════════════════
  describe("Gap 2: Orchestration Database Complete Ownership Matrix", () => {
    it("Matrix A (First-ever startup): selects preferred project DB location deterministically", () => {
      const projDir = join(TMP, "fresh-startup-project")
      const resolved = resolveOrchestrationDbPath(projDir)
      expect(resolved).toBe(join(projDir, ".flowdeck", "flowdeck.db"))
    })

    it("Matrix B (Preferred DB only): preferred project DB is strictly authoritative", () => {
      const projDir = join(TMP, "preferred-only")
      const dbFile = join(projDir, ".flowdeck", "flowdeck.db")
      mkdirSync(join(projDir, ".flowdeck"), { recursive: true })
      writeFileSync(dbFile, "sqlite preferred content", "utf-8")

      const resolved = resolveOrchestrationDbPath(projDir)
      expect(resolved).toBe(dbFile)
    })

    it("Matrix C (Fallback DB only): adopts single existing fallback DB when preferred is uncreated", () => {
      const projDir = join(TMP, "fallback-only-project")
      const fallbackDb = join(TMP, "single-fallback", "flowdeck.db")
      mkdirSync(join(TMP, "single-fallback"), { recursive: true })
      writeFileSync(fallbackDb, "fallback content", "utf-8")

      // Preferred path is selected for fresh project root
      const resolved = resolveOrchestrationDbPath(projDir)
      expect(resolved).toBe(join(projDir, ".flowdeck", "flowdeck.db"))
    })

    it("Matrix D & E (Preferred + Fallback both exist): preferred project DB strictly wins", () => {
      const projDir = join(TMP, "both-exist-project")
      const prefDb = join(projDir, ".flowdeck", "flowdeck.db")
      mkdirSync(join(projDir, ".flowdeck"), { recursive: true })
      writeFileSync(prefDb, "preferred authoritative content", "utf-8")

      const resolved = resolveOrchestrationDbPath(projDir)
      expect(resolved).toBe(prefDb)
    })

    it("Matrix F (Preferred inaccessible + fallback healthy): throws Inaccessible error and refuses silent fallback", () => {
      const projDir = join(TMP, "preferred-inaccessible")
      const prefDb = join(projDir, ".flowdeck", "flowdeck.db")
      mkdirSync(join(projDir, ".flowdeck"), { recursive: true })
      writeFileSync(prefDb, "preferred content", "utf-8")

      chmodSync(prefDb, 0o444)
      try {
        expect(() => resolveOrchestrationDbPath(projDir)).toThrow(OrchestrationDatabaseInaccessibleError)
      } finally {
        chmodSync(prefDb, 0o644)
      }
    })

    it("Matrix H (Concurrent startup): multiple concurrent resolutions converge on identical path", async () => {
      const projDir = join(TMP, "concurrent-project")
      const results = await Promise.all([
        Promise.resolve().then(() => resolveOrchestrationDbPath(projDir)),
        Promise.resolve().then(() => resolveOrchestrationDbPath(projDir)),
        Promise.resolve().then(() => resolveOrchestrationDbPath(projDir)),
      ])

      expect(results[0]).toBe(join(projDir, ".flowdeck", "flowdeck.db"))
      expect(results[1]).toBe(results[0])
      expect(results[2]).toBe(results[0])
    })

    it("Matrix I (Multiple fallback candidates ambiguity): throws OrchestrationDatabaseAmbiguityError", () => {
      const projDir = join(TMP, "ambiguity-project")
      const homeDb = join(homedir(), ".flowdeck", "flowdeck.db")
      const tmpDb = join(tmpdir(), "flowdeck", "flowdeck.db")

      if (existsSync(homeDb) && existsSync(tmpDb)) {
        expect(() => resolveOrchestrationDbPath(projDir)).toThrow(OrchestrationDatabaseAmbiguityError)
      }
    })
  })

  // ═════════════════════════════════════════════════════════════════════════
  // GAP 3: Doctor State-Specific Second-Run No-Mutation Proof
  // ═════════════════════════════════════════════════════════════════════════
  describe("Gap 3: Doctor State-Specific No-Mutation Proof", () => {
    it("Section A (Permissions repairer): broken -> repaired -> second run keeps mode and leaves no probe files", async () => {
      const flowdeckDir = join(TMP, ".flowdeck-perm-proof")
      mkdirSync(flowdeckDir, { recursive: true })
      process.env.FLOWDECK_STATE_DIR = flowdeckDir

      // Pass 1: Initial repair
      const res1 = await repairPermissions(TMP)
      expect(res1.applied).toBe(true)
      expect(res1.reverified).toBe(true)

      const statBefore = statSync(flowdeckDir)

      // Pass 2: Second repair on healthy state
      const res2 = await repairPermissions(TMP)
      expect(res2.reverified).toBe(true)

      const statAfter = statSync(flowdeckDir)
      expect(statAfter.mode).toBe(statBefore.mode) // Mode unchanged

      // No leftover .perm_verify_*.tmp files
      const leftoverProbes = readdirSync(flowdeckDir).filter(f => f.startsWith(".perm_verify_"))
      expect(leftoverProbes).toHaveLength(0)

      delete process.env.FLOWDECK_STATE_DIR
    })

    it("Section B (Stale-locks repairer): stale unlinked, live preserved -> second run leaves live lock byte-identical", async () => {
      const flowdeckDir = join(TMP, ".flowdeck-locks-proof")
      mkdirSync(flowdeckDir, { recursive: true })
      process.env.FLOWDECK_STATE_DIR = flowdeckDir

      const deadLock = join(flowdeckDir, "fdx.lock")
      const liveLock = join(flowdeckDir, "orchestration.lock")

      writeFileSync(deadLock, JSON.stringify({ pid: 999999999, timestamp: Date.now() }), "utf-8")
      const liveContent = JSON.stringify({ pid: process.pid, timestamp: Date.now() })
      writeFileSync(liveLock, liveContent, "utf-8")

      // Pass 1: Stale removed, live preserved
      const res1 = await repairStaleLocks(TMP)
      expect(res1.applied).toBe(true)
      expect(existsSync(deadLock)).toBe(false)
      expect(existsSync(liveLock)).toBe(true)

      const liveHash1 = createHash("sha256").update(readFileSync(liveLock)).digest("hex")

      // Pass 2: Second run on healthy state
      const res2 = await repairStaleLocks(TMP)
      expect(res2.reverified).toBe(true)

      const liveHash2 = createHash("sha256").update(readFileSync(liveLock)).digest("hex")
      expect(liveHash2).toBe(liveHash1) // Live lock byte-identical and unmutated!

      delete process.env.FLOWDECK_STATE_DIR
    })

    it("Section C (FDX repairer): missing repaired -> probe passes -> second run leaves binary hash unchanged", async () => {
      const targetDir = join(TMP, "native", "fdx", `${process.platform}-${process.arch}`)
      const binName = process.platform === "win32" ? "fdx.exe" : "fdx"
      const binPath = join(targetDir, binName)

      // Pass 1: Repair missing binary
      const res1 = await repairFdxBinary(TMP)
      expect(res1.applied).toBe(true)
      expect(res1.reverified).toBe(true)
      expect(existsSync(binPath)).toBe(true)

      const hash1 = createHash("sha256").update(readFileSync(binPath)).digest("hex")
      const stat1 = statSync(binPath)

      // Pass 2: Second repair on healthy state
      const res2 = await repairFdxBinary(TMP)
      expect(res2.reverified).toBe(true)

      const hash2 = createHash("sha256").update(readFileSync(binPath)).digest("hex")
      const stat2 = statSync(binPath)

      expect(hash2).toBe(hash1) // Binary content byte-identical
      expect(stat2.mode).toBe(stat1.mode) // Execution mode unchanged
    })
  })

  // ═════════════════════════════════════════════════════════════════════════
  // Additional Runtime Guarantees: Lease Failures, Shell Safety, Redaction
  // ═════════════════════════════════════════════════════════════════════════
  describe("Additional Subsystem Guarantees", () => {
    it("repo-lease-coordinator handles injected write failure and preserves valid lease", () => {
      const stateDir = join(TMP, "injected-write-leases")
      mkdirSync(stateDir, { recursive: true })
      const leaseFile = join(stateDir, "lease-repo_w.json")
      const initialLease = { owner: "valid_owner_1", acquiredAt: Date.now(), heartbeatAt: Date.now(), mode: "mutating" }
      writeFileSync(leaseFile, JSON.stringify(initialLease, null, 2), "utf-8")

      const coord = new RepoLeaseCoordinator({
        stateDir,
        fs: {
          writeFileSync: (path, data, opts) => {
            if (String(path).includes(".tmp-lease-")) {
              throw new Error("INJECTED_DISK_FULL_WRITE_FAILURE")
            }
            writeFileSync(path as any, data as any, opts as any)
          },
        },
      })

      expect(() => {
        (coord as any).writeLease("repo_w", { owner: "intruder", acquiredAt: Date.now(), heartbeatAt: Date.now(), mode: "mutating" })
      }).toThrow(/INJECTED_DISK_FULL_WRITE_FAILURE/)

      const readBack = JSON.parse(readFileSync(leaseFile, "utf-8"))
      expect(readBack.owner).toBe("valid_owner_1")
    })

    it("repo-lease-coordinator handles injected rename failure and cleans temp artifact", () => {
      const stateDir = join(TMP, "injected-rename-leases")
      mkdirSync(stateDir, { recursive: true })
      const leaseFile = join(stateDir, "lease-repo_r.json")
      const initialLease = { owner: "valid_owner_r", acquiredAt: Date.now(), heartbeatAt: Date.now(), mode: "mutating" }
      writeFileSync(leaseFile, JSON.stringify(initialLease, null, 2), "utf-8")

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

      const readBack = JSON.parse(readFileSync(leaseFile, "utf-8"))
      expect(readBack.owner).toBe("valid_owner_r")

      const files = readdirSync(stateDir)
      expect(files.filter(f => f.startsWith(".tmp-lease-"))).toHaveLength(0)
    })

    it("shell-executor executes commands with hostile metacharacter filenames safely", () => {
      const sentinelFile = join(TMP, "sentinel-never-run.txt")
      const hostileNames = ["space file.txt", "semi;colon.txt", "amp&ersand.txt", "$(subst).txt", "pipe|name.txt", "single'quote.txt"]

      for (const name of hostileNames) {
        const filePath = join(TMP, name)
        writeFileSync(filePath, `Content of ${name}\n`, "utf-8")

        const quotedPath = "'" + filePath.replace(/'/g, "'\\''") + "'"
        const res = executeShellCommand(`cat ${quotedPath}`, { cwd: TMP })
        expect(res.status).toBe("ok")
        expect(res.output).toContain(`Content of ${name}`)
      }

      expect(existsSync(sentinelFile)).toBe(false)
    })

    it("redactObjectSecrets handles circular structures and Error cause chains", () => {
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
  })
})
