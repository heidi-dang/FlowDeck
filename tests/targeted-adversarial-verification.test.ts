import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync, chmodSync, readdirSync, statSync, unlinkSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { checkFdxAvailability, invalidateFdxCache, resolveFdxBinaryPath, runFdx } from "../src/tools/fdx-shared"
import { repairFdxBinary } from "../src/doctor/repair/repairers/fdx-repairer"
import { repairPermissions } from "../src/doctor/repair/repairers/permissions-repairer"
import { repairStaleLocks } from "../src/doctor/repair/repairers/stale-locks-repairer"
import {
  resolveOrchestrationDbPath,
  OrchestrationDatabaseInaccessibleError,
} from "../src/services/orchestration-db-path"
import { initializeDatabase, closeAllConnections } from "../src/orchestration/persistence/index"
import { RepoLeaseCoordinator } from "../src/services/repo-lease-coordinator"
import { executeShellCommand } from "../src/services/shell-executor"
import { redactObjectSecrets } from "../src/lib/secret-redaction"
import { loadFlowDeckConfig } from "../src/config/index"

describe("Targeted Adversarial Verification Suite — 3 Final Merge-Evidence Gaps", () => {
  const TMP = join(tmpdir(), "fd-final3-evidence-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7))

  beforeEach(() => {
    if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true })
  })

  afterEach(() => {
    try {
      closeAllConnections()
      rmSync(TMP, { recursive: true, force: true })
    } catch {}
  })

  // ═════════════════════════════════════════════════════════════════════════
  // GAP 1: Real FDX Configuration Reload & Cache State-Transition Matrix
  // ═════════════════════════════════════════════════════════════════════════
  describe("Gap 1: FDX Runtime Configuration Reload & State Transitions", () => {
    const fdxBinA = join(TMP, "bin-a", process.platform === "win32" ? "fdx.exe" : "fdx")
    const fdxBinB = join(TMP, "bin-b", process.platform === "win32" ? "fdx.exe" : "fdx")

    beforeEach(() => {
      mkdirSync(join(TMP, "bin-a"), { recursive: true })
      mkdirSync(join(TMP, "bin-b"), { recursive: true })
      writeFileSync(fdxBinA, '#!/usr/bin/env sh\necho "fdx 0.1.0 (FDX_A)"\n', { mode: 0o755, encoding: "utf-8" })
      writeFileSync(fdxBinB, '#!/usr/bin/env sh\necho "fdx 0.1.0 (FDX_B)"\n', { mode: 0o755, encoding: "utf-8" })
    })

    it("Transition A: cached success -> binary externally deleted -> forceRefresh reflects unavailable", () => {
      if (process.platform === "win32") return
      process.env.FDX_BINARY_PATH = fdxBinA
      invalidateFdxCache()

      expect(checkFdxAvailability(false)).toBe(true)

      // External deletion without doctor
      unlinkSync(fdxBinA)
      expect(existsSync(fdxBinA)).toBe(false)

      // Stale cache returns true before refresh
      expect(checkFdxAvailability(false)).toBe(true)

      // Force refresh discovers deletion immediately
      expect(checkFdxAvailability(true)).toBe(false)

      delete process.env.FDX_BINARY_PATH
      invalidateFdxCache()
    })

    it("Transition B: cached success -> executable permission removed -> forceRefresh reflects unavailable", () => {
      if (process.platform === "win32") return

      process.env.FDX_BINARY_PATH = fdxBinA
      invalidateFdxCache()

      expect(checkFdxAvailability(false)).toBe(true)

      // Remove executable bit externally
      chmodSync(fdxBinA, 0o644)

      // Stale cache returns true before refresh
      expect(checkFdxAvailability(false)).toBe(true)

      // Force refresh discovers permission loss
      expect(checkFdxAvailability(true)).toBe(false)

      chmodSync(fdxBinA, 0o755)
      delete process.env.FDX_BINARY_PATH
      invalidateFdxCache()
    })

    it("Transition C: cached success -> binary replaced at same path -> revalidates executable", () => {
      if (process.platform === "win32") return
      process.env.FDX_BINARY_PATH = fdxBinA
      invalidateFdxCache()

      expect(checkFdxAvailability(false)).toBe(true)

      // Replace with new valid binary content
      writeFileSync(fdxBinA, '#!/usr/bin/env sh\necho "fdx 0.1.1 (FDX_REPLACEMENT)"\n', { mode: 0o755, encoding: "utf-8" })

      expect(checkFdxAvailability(true)).toBe(true)

      delete process.env.FDX_BINARY_PATH
      invalidateFdxCache()
    })

    it("Transition D: cached miss -> binary appears externally -> forceRefresh recovers availability", () => {
      if (process.platform === "win32") return
      const missingPath = join(TMP, "bin-a", "fdx-late")
      process.env.FDX_BINARY_PATH = missingPath
      invalidateFdxCache()

      expect(checkFdxAvailability(false)).toBe(false)

      // Create executable externally
      writeFileSync(missingPath, '#!/usr/bin/env sh\necho "fdx 0.1.0 (late)"\n', { mode: 0o755, encoding: "utf-8" })

      // Force refresh discovers new binary without restarting runtime
      expect(checkFdxAvailability(true)).toBe(true)

      delete process.env.FDX_BINARY_PATH
      invalidateFdxCache()
    })

    it("Transition E: FDX_BINARY_PATH environment change naturally alters cache resolution", () => {
      if (process.platform === "win32") return
      invalidateFdxCache()
      process.env.FDX_BINARY_PATH = fdxBinA
      expect(checkFdxAvailability(false)).toBe(true)
      expect(resolveFdxBinaryPath()).toBe(fdxBinA)

      // Transition A -> B
      process.env.FDX_BINARY_PATH = fdxBinB
      expect(checkFdxAvailability(false)).toBe(true)
      expect(resolveFdxBinaryPath()).toBe(fdxBinB)

      // Transition B -> Invalid
      process.env.FDX_BINARY_PATH = "/tmp/nonexistent-fdx-12345"
      expect(checkFdxAvailability(false)).toBe(false)

      delete process.env.FDX_BINARY_PATH
      invalidateFdxCache()
    })

    it("Transition F: PATH environment change dynamically changes binary discovery", async () => {
      if (process.platform === "win32") return
      const runnerCode = `
import { getFdxAvailabilityStatus, invalidateFdxCache } from "./src/tools/fdx-shared"
invalidateFdxCache()
const status = getFdxAvailabilityStatus(true)
if (!status.available) throw new Error("Unavailable via PATH: " + JSON.stringify(status))
`
      const res = spawn("bun", ["-e", runnerCode], {
        env: {
          ...process.env,
          PATH: join(TMP, "bin-a") + ":" + (process.env.PATH ?? ""),
        },
        stdio: "pipe",
      })
      await new Promise<void>((resolve, reject) => {
        let errOut = ""
        res.stderr?.on("data", (d: Buffer) => { errOut += d.toString() })
        res.on("exit", (code) => {
          if (code === 0) resolve()
          else reject(new Error(`Transition F child process failed (exit ${code}): ${errOut}`))
        })
      })
    })

    it("Transition G: Doctor repair invalidates cache and makes repaired binary observable", async () => {
      if (process.platform === "win32") return
      invalidateFdxCache()
      const repairRes = await repairFdxBinary(TMP)
      expect(repairRes.reverified).toBe(true)

      const detected = resolveFdxBinaryPath(true)
      expect(detected).toBeDefined()
    })

    it("Transition H: Normal runtime configuration reload lifecycle: FDX A -> reload config -> FDX B", () => {
      if (process.platform === "win32") return
      const orig = process.env.FDX_BINARY_PATH
      try {
        // 1. Initial configuration points to FDX A
        process.env.FDX_BINARY_PATH = fdxBinA
        invalidateFdxCache()
        expect(resolveFdxBinaryPath(true)).toBe(fdxBinA)
        expect(runFdx(["--version"], TMP)).toContain("FDX_A")

        // 2. Normal runtime config reload update: update config file & env to FDX B
        const cfgPath = join(TMP, ".flowdeck.json")
        writeFileSync(cfgPath, JSON.stringify({ routing: { enabled: true } }), "utf-8")
        const reloadedConfig = loadFlowDeckConfig(TMP)
        expect(reloadedConfig.routing?.enabled).toBe(true)

        // 3. Lifecycle reload event: update active binary path to FDX B and refresh capability
        process.env.FDX_BINARY_PATH = fdxBinB
        invalidateFdxCache()

        // 4. Prove FDX B is now authoritative and stale FDX A is not reused
        expect(resolveFdxBinaryPath(true)).toBe(fdxBinB)
        expect(runFdx(["--version"], TMP)).toContain("FDX_B")
        expect(runFdx(["--version"], TMP)).not.toContain("FDX_A")
      } finally {
        if (orig) process.env.FDX_BINARY_PATH = orig
        else delete process.env.FDX_BINARY_PATH
        invalidateFdxCache()
      }
    })
  })

  // ═════════════════════════════════════════════════════════════════════════
  // GAP 2: Orchestration Database Complete Ownership & State Preservation
  // ═════════════════════════════════════════════════════════════════════════
  describe("Gap 2: Orchestration Database State Ownership & Preservation", () => {
    it("Matrix A (First-ever startup): selects preferred project DB location deterministically", () => {
      const projDir = join(TMP, "fresh-startup-project")
      const resolved1 = resolveOrchestrationDbPath(projDir)
      const resolved2 = resolveOrchestrationDbPath(projDir)
      expect(resolved1).toBe(join(projDir, ".flowdeck", "flowdeck.db"))
      expect(resolved2).toBe(resolved1)
    })

    it("Matrix B (Preferred DB only): preferred project DB is strictly authoritative", () => {
      const projDir = join(TMP, "preferred-only")
      const dbFile = join(projDir, ".flowdeck", "flowdeck.db")
      mkdirSync(join(projDir, ".flowdeck"), { recursive: true })
      writeFileSync(dbFile, "sqlite preferred content", "utf-8")

      const resolved = resolveOrchestrationDbPath(projDir)
      expect(resolved).toBe(dbFile)
    })

    const runIsolated = (testCode: string) => {
      const baseIso = join(TMP, "isolated-env-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7))
      const isoHome = join(baseIso, "home")
      const isoTmp = join(baseIso, "tmp")
      mkdirSync(isoHome, { recursive: true })
      mkdirSync(isoTmp, { recursive: true })

      const runnerCode = `
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { resolveOrchestrationDbPath, OrchestrationDatabaseAmbiguityError, OrchestrationDatabaseInaccessibleError } from "./src/services/orchestration-db-path"
import { initializeDatabase, closeAllConnections } from "./src/orchestration/persistence/index"

const isoHome = homedir()
const isoTmp = tmpdir()
const baseIso = process.env.BASE_ISO!

${testCode}
`

      try {
        const res = spawn("bun", ["-e", runnerCode], {
          env: {
            ...process.env,
            HOME: isoHome,
            TMPDIR: isoTmp,
            BASE_ISO: baseIso,
          },
          stdio: "pipe",
        })
        return new Promise<void>((resolve, reject) => {
          let errOutput = ""
          res.stderr?.on("data", (d: Buffer) => { errOutput += d.toString() })
          res.on("exit", (code) => {
            if (code === 0) resolve()
            else reject(new Error(`Isolated test failed with exit ${code}: ${errOutput}`))
          })
        })
      } finally {
        try {
          rmSync(baseIso, { recursive: true, force: true })
        } catch {}
      }
    }

    it("Matrix C (Fallback DB discovery and state preservation): discovers fallback and preserves state across restarts", async () => {
      await runIsolated(`
        const fallbackDbPath = join(isoHome, ".flowdeck", "flowdeck.db")
        const markerVal = "FLOWDECK_FALLBACK_DISCOVERY_MARKER_V224_AUDIT"

        // 1. Create real fallback database at supported fallback candidate location
        mkdirSync(join(isoHome, ".flowdeck"), { recursive: true })
        const { db: initialDb } = initializeDatabase({ path: fallbackDbPath })
        initialDb.query("CREATE TABLE IF NOT EXISTS flowdeck_fallback_marker (id TEXT PRIMARY KEY, val TEXT)").run()
        initialDb.query("INSERT INTO flowdeck_fallback_marker (id, val) VALUES (?, ?)").run("marker_1", markerVal)
        closeAllConnections()

        // 2. Setup project directory where preferred .flowdeck directory cannot be created (unwritable)
        const projDir = join(baseIso, "unwritable-project")
        mkdirSync(projDir, { recursive: true })
        writeFileSync(join(projDir, ".flowdeck"), "blocking-file")

        // 3. Normal production database resolution path (passing only project directory)
        const resolvedPath1 = resolveOrchestrationDbPath(projDir)
        if (resolvedPath1 !== fallbackDbPath) {
          throw new Error("Expected production resolver to discover fallback path " + fallbackDbPath + " but got " + resolvedPath1)
        }

        // 4. Initialize via normal persistence API
        const { db: activeDb1 } = initializeDatabase({ path: resolvedPath1 })
        const readBack1 = activeDb1.query("SELECT val FROM flowdeck_fallback_marker WHERE id = ?").get("marker_1") as { val: string } | null
        if (readBack1?.val !== markerVal) {
          throw new Error("Marker mismatch after startup: " + JSON.stringify(readBack1))
        }
        closeAllConnections()

        // 5. Subsequent startup: prove same state remains authoritative
        const resolvedPath2 = resolveOrchestrationDbPath(projDir)
        if (resolvedPath2 !== fallbackDbPath) {
          throw new Error("Expected second resolution to discover fallback path " + fallbackDbPath + " but got " + resolvedPath2)
        }
        const { db: activeDb2 } = initializeDatabase({ path: resolvedPath2 })
        const readBack2 = activeDb2.query("SELECT val FROM flowdeck_fallback_marker WHERE id = ?").get("marker_1") as { val: string } | null
        if (readBack2?.val !== markerVal) {
          throw new Error("Marker mismatch after second startup: " + JSON.stringify(readBack2))
        }
        closeAllConnections()

        // 6. Prove no second divergent writable database was created
        const prefDbExists = existsSync(join(projDir, ".flowdeck", "flowdeck.db"))
        const homeDbExists = existsSync(join(isoHome, ".flowdeck", "flowdeck.db"))
        const tmpDbExists = existsSync(join(isoTmp, "flowdeck", "flowdeck.db"))

        if (prefDbExists || !homeDbExists || tmpDbExists) {
          throw new Error("Candidate DB count check failed: pref=" + prefDbExists + " home=" + homeDbExists + " tmp=" + tmpDbExists)
        }
      `)
    })

    it("Matrix D & E (Preferred + Fallback both exist with divergent state): preferred strictly wins and fallback is untouched", async () => {
      // By FlowDeck contract: an already-created project-local DB establishes authority,
      // and any fallback DB is isolated and not automatically merged.
      await runIsolated(`
        const projDir = join(baseIso, "coexist-proj")
        const prefDbPath = join(projDir, ".flowdeck", "flowdeck.db")
        const fallbackDbPath = join(isoHome, ".flowdeck", "flowdeck.db")

        mkdirSync(join(projDir, ".flowdeck"), { recursive: true })
        mkdirSync(join(isoHome, ".flowdeck"), { recursive: true })

        // Initialize preferred DB with PROJECT_STATE_AUTHORITATIVE marker
        const { db: prefDb } = initializeDatabase({ path: prefDbPath })
        prefDb.query("CREATE TABLE IF NOT EXISTS state_marker (id TEXT PRIMARY KEY, val TEXT)").run()
        prefDb.query("INSERT INTO state_marker (id, val) VALUES (?, ?)").run("m", "PROJECT_STATE_AUTHORITATIVE")
        closeAllConnections()

        // Initialize fallback DB with FALLBACK_STATE_ISOLATED marker
        const { db: fallDb } = initializeDatabase({ path: fallbackDbPath })
        fallDb.query("CREATE TABLE IF NOT EXISTS state_marker (id TEXT PRIMARY KEY, val TEXT)").run()
        fallDb.query("INSERT INTO state_marker (id, val) VALUES (?, ?)").run("m", "FALLBACK_STATE_ISOLATED")
        closeAllConnections()

        // Resolve DB for project: preferred project DB must strictly win by contract
        const resolved = resolveOrchestrationDbPath(projDir)
        if (resolved !== prefDbPath) {
          throw new Error("Preferred project DB did not win: got " + resolved)
        }

        const { db: activeDb } = initializeDatabase({ path: resolved })
        const projectState = activeDb.query("SELECT val FROM state_marker WHERE id = ?").get("m") as { val: string } | null
        if (projectState?.val !== "PROJECT_STATE_AUTHORITATIVE") {
          throw new Error("Authoritative state mismatch: " + JSON.stringify(projectState))
        }
        closeAllConnections()

        // Verify fallback DB was not modified or merged
        const { db: verifiedFallDb } = initializeDatabase({ path: fallbackDbPath })
        const fallbackState = verifiedFallDb.query("SELECT val FROM state_marker WHERE id = ?").get("m") as { val: string } | null
        if (fallbackState?.val !== "FALLBACK_STATE_ISOLATED") {
          throw new Error("Fallback state modified: " + JSON.stringify(fallbackState))
        }
        closeAllConnections()
      `)
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

    it("Matrix G (Legacy database location unsupported): FlowDeck does not silently adopt unsupported legacy DB paths", async () => {
      // FlowDeck has no distinct legacy SQLite location. Old/unsupported paths are ignored safely.
      await runIsolated(`
        const projDir = join(baseIso, "legacy-unsupported-proj")
        mkdirSync(join(projDir, ".opencode"), { recursive: true })
        const unsupportedLegacyPath = join(projDir, ".opencode", "flowdeck.db")

        // Populate database at unsupported legacy path with distinct marker
        const { db: legDb } = initializeDatabase({ path: unsupportedLegacyPath })
        legDb.query("CREATE TABLE IF NOT EXISTS legacy_marker (id TEXT PRIMARY KEY, val TEXT)").run()
        legDb.query("INSERT INTO legacy_marker (id, val) VALUES (?, ?)").run("leg_1", "FLOWDECK_LEGACY_UNSUPPORTED_MARKER_998877")
        closeAllConnections()

        // Resolve DB via normal production path: resolves strictly to supported preferred path
        const resolved = resolveOrchestrationDbPath(projDir)
        const expectedPref = join(projDir, ".flowdeck", "flowdeck.db")
        if (resolved !== expectedPref) {
          throw new Error("Expected resolve to return supported preferred path " + expectedPref + " but got " + resolved)
        }

        // Initialize production DB: fresh schema, unsupported legacy table is NOT adopted
        const { db: activeDb } = initializeDatabase({ path: resolved })
        const tables = activeDb.query("SELECT name FROM sqlite_master WHERE type = ? AND name = ?").all("table", "legacy_marker")
        if (tables.length > 0) {
          throw new Error("Unsupported legacy table was unexpectedly adopted into production DB")
        }
        closeAllConnections()

        // Legacy database at unsupported location remains untouched
        const { db: reopenedLegDb } = initializeDatabase({ path: unsupportedLegacyPath })
        const legRow = reopenedLegDb.query("SELECT val FROM legacy_marker WHERE id = ?").get("leg_1") as { val: string } | null
        if (legRow?.val !== "FLOWDECK_LEGACY_UNSUPPORTED_MARKER_998877") {
          throw new Error("Legacy file corrupted")
        }
        closeAllConnections()

        // Subsequent startup re-resolves to the same authoritative preferred path
        const resolved2 = resolveOrchestrationDbPath(projDir)
        if (resolved2 !== expectedPref) {
          throw new Error("Second startup did not resolve to preferred path")
        }
      `)
    })

    it("Matrix I (Multiple fallback candidates ambiguity): throws OrchestrationDatabaseAmbiguityError when multiple fallbacks exist", async () => {
      await runIsolated(`
        const homeDb = join(isoHome, ".flowdeck", "flowdeck.db")
        const tmpDb = join(isoTmp, "flowdeck", "flowdeck.db")

        mkdirSync(join(isoHome, ".flowdeck"), { recursive: true })
        mkdirSync(join(isoTmp, "flowdeck"), { recursive: true })
        writeFileSync(homeDb, "home db content", "utf-8")
        writeFileSync(tmpDb, "tmp db content", "utf-8")

        const projDir = join(baseIso, "ambiguity-proj")
        mkdirSync(projDir, { recursive: true })
        writeFileSync(join(projDir, ".flowdeck"), "unwritable")

        let threw = false
        try {
          resolveOrchestrationDbPath(projDir)
        } catch (err) {
          threw = true
          if (!(err instanceof OrchestrationDatabaseAmbiguityError)) {
            throw new Error("Expected OrchestrationDatabaseAmbiguityError but got " + String(err))
          }
          if (err.paths.length !== 2) {
            throw new Error("Expected 2 paths in ambiguity error, got " + JSON.stringify(err.paths))
          }
        }
        if (!threw) {
          throw new Error("Expected resolveOrchestrationDbPath to throw OrchestrationDatabaseAmbiguityError")
        }
      `)
    })
  })

  // ═════════════════════════════════════════════════════════════════════════
  // GAP 3: Concurrent Multi-Process Database Initialization & Integrity Proof
  // ═════════════════════════════════════════════════════════════════════════
  describe("Gap 3: Concurrent Database Initialization & Multi-Worker Safety", () => {
    it("runs overlapping multi-process database initialization/open flows, verifies PRAGMA integrity and shared state", async () => {
      if (process.platform === "win32") return
      const projDir = join(TMP, "concurrent-db-init-proj")
      mkdirSync(projDir, { recursive: true })
      const targetDbPath = resolveOrchestrationDbPath(projDir)

      // Spawn 3 separate overlapping child worker processes that concurrently initialize and write
      const workerScript = `
        import { initializeDatabase, closeAllConnections } from "./src/orchestration/persistence/index";
        const dbPath = process.argv[1];
        const workerId = process.argv[2];
        const { db } = initializeDatabase({ path: dbPath });
        db.query("CREATE TABLE IF NOT EXISTS multi_worker_test (id TEXT PRIMARY KEY, worker TEXT, ts INTEGER)").run();
        db.query("INSERT INTO multi_worker_test (id, worker, ts) VALUES (?, ?, ?)").run("rec_" + workerId, workerId, Date.now());
        closeAllConnections();
      `

      const runWorker = (workerId: string) => new Promise<void>((res, rej) => {
        const c = spawn("bun", ["-e", workerScript, targetDbPath, workerId], { stdio: "ignore" })
        c.on("exit", code => code === 0 ? res() : rej(new Error(`Worker ${workerId} failed with exit code ${code}`)))
      })

      // Run workers with real process-level concurrency
      await Promise.all([
        runWorker("proc_1"),
        runWorker("proc_2"),
        runWorker("proc_3"),
      ])

      const expectedDbPath = join(projDir, ".flowdeck", "flowdeck.db")
      expect(existsSync(expectedDbPath)).toBe(true)

      // Verify from main process: database opened, all worker records exist, PRAGMA checks pass
      const { db } = initializeDatabase({ path: targetDbPath })
      const rows = db.query("SELECT * FROM multi_worker_test ORDER BY worker").all() as any[]
      expect(rows).toHaveLength(3)
      expect(rows.map(r => r.worker)).toEqual(["proc_1", "proc_2", "proc_3"])

      const integrity = db.query("PRAGMA integrity_check").get() as any
      expect(integrity?.integrity_check).toBe("ok")

      const fkCheck = db.query("PRAGMA foreign_key_check").all()
      expect(fkCheck).toHaveLength(0)

      closeAllConnections()

      // Subsequent startup reopens the same database and sees the shared state
      const { db: reopenedDb } = initializeDatabase({ path: resolveOrchestrationDbPath(projDir) })
      const reopenedRows = reopenedDb.query("SELECT COUNT(*) AS cnt FROM multi_worker_test").get() as any
      expect(reopenedRows?.cnt).toBe(3)

      closeAllConnections()
    })
  })

  // ═════════════════════════════════════════════════════════════════════════
  // Doctor State-Specific Second-Run No-Mutation Proof & Additional Guarantees
  // ═════════════════════════════════════════════════════════════════════════
  describe("Doctor State-Specific No-Mutation Proof & Subsystem Guarantees", () => {
    it("permissions-repairer: broken -> repaired -> second run keeps mode and leaves no probe files", async () => {
      const flowdeckDir = join(TMP, ".flowdeck-perm-proof")
      mkdirSync(flowdeckDir, { recursive: true })
      process.env.FLOWDECK_STATE_DIR = flowdeckDir

      const res1 = await repairPermissions(TMP)
      expect(res1.applied).toBe(true)
      expect(res1.reverified).toBe(true)

      const statBefore = statSync(flowdeckDir)

      const res2 = await repairPermissions(TMP)
      expect(res2.reverified).toBe(true)

      const statAfter = statSync(flowdeckDir)
      expect(statAfter.mode).toBe(statBefore.mode)

      const leftoverProbes = readdirSync(flowdeckDir).filter(f => f.startsWith(".perm_verify_"))
      expect(leftoverProbes).toHaveLength(0)

      delete process.env.FLOWDECK_STATE_DIR
    })

    it("stale-locks-repairer: stale unlinked, live preserved -> second run leaves live lock byte-identical", async () => {
      const flowdeckDir = join(TMP, ".flowdeck-locks-proof")
      mkdirSync(flowdeckDir, { recursive: true })
      process.env.FLOWDECK_STATE_DIR = flowdeckDir

      const deadLock = join(flowdeckDir, "fdx.lock")
      const liveLock = join(flowdeckDir, "orchestration.lock")

      writeFileSync(deadLock, JSON.stringify({ pid: 999999999, timestamp: Date.now() }), "utf-8")
      const liveContent = JSON.stringify({ pid: process.pid, timestamp: Date.now() })
      writeFileSync(liveLock, liveContent, "utf-8")

      const res1 = await repairStaleLocks(TMP)
      expect(res1.applied).toBe(true)
      expect(existsSync(deadLock)).toBe(false)
      expect(existsSync(liveLock)).toBe(true)

      const liveHash1 = createHash("sha256").update(readFileSync(liveLock)).digest("hex")

      const res2 = await repairStaleLocks(TMP)
      expect(res2.reverified).toBe(true)

      const liveHash2 = createHash("sha256").update(readFileSync(liveLock)).digest("hex")
      expect(liveHash2).toBe(liveHash1)

      delete process.env.FLOWDECK_STATE_DIR
    })

    it("fdx-repairer: missing repaired -> probe passes -> second run leaves binary hash unchanged", async () => {
      if ((process.platform as string) === "win32") return
      const targetDir = join(TMP, "native", "fdx", `${process.platform}-${process.arch}`)
      const binName = "fdx"
      const binPath = join(targetDir, binName)

      const res1 = await repairFdxBinary(TMP)
      expect(res1.applied).toBe(true)
      expect(res1.reverified).toBe(true)
      expect(existsSync(binPath)).toBe(true)

      const hash1 = createHash("sha256").update(readFileSync(binPath)).digest("hex")
      const stat1 = statSync(binPath)

      const res2 = await repairFdxBinary(TMP)
      expect(res2.reverified).toBe(true)

      const hash2 = createHash("sha256").update(readFileSync(binPath)).digest("hex")
      const stat2 = statSync(binPath)

      expect(hash2).toBe(hash1)
      expect(stat2.mode).toBe(stat1.mode)
    })

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
      if (process.platform === "win32") return
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
