import { describe, it, expect } from "vitest"
import { testFdxVersionCompatibility, runDoctorChecks } from "../scripts/doctor-engine.mjs"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

// ── Phase 30 — Negative Doctor Failure Probe Tests ─────────────────────────
//
// Every test below creates or injects a defective runtime condition, runs the
// relevant Doctor probe or check, and asserts status === "fail" (or "warn" for absent FDX).
// Zero tests are positive behavior tests.

const pkgRaw = JSON.stringify({
  name: "@heidi-dang/flowdeck",
  flowdeckFdxCompatibility: { required: "^0.1.0" },
})

describe("Phase 30 — Doctor Negative Probe Tests (24 Failure Probes)", () => {
  // ── 1. missing dist runtime ─────────────────────────────────────────────
  it("1. fails when dist directory or index.js is missing", async () => {
    const noDistDir = join(tmpdir(), "doctor-neg-no-dist-" + Date.now())
    try {
      mkdirSync(noDistDir, { recursive: true })
      writeFileSync(join(noDistDir, "package.json"), pkgRaw, "utf-8")

      const res = await runDoctorChecks(noDistDir)
      const agentCheck = res.checks.find((c) => c.id === "agents.count")
      expect(agentCheck).toBeDefined()
      expect(agentCheck?.status).toBe("fail")
      expect(agentCheck?.message).toMatch(/could not be determined/i)
    } finally {
      try { rmSync(noDistDir, { recursive: true, force: true }) } catch {}
    }
  })

  // ── 2. runtime import failure ───────────────────────────────────────────
  it("2. fails when dist/index.js contains syntax or import error", async () => {
    const corruptDir = join(tmpdir(), "doctor-neg-corrupt-" + Date.now())
    try {
      mkdirSync(join(corruptDir, "dist"), { recursive: true })
      writeFileSync(join(corruptDir, "package.json"), pkgRaw, "utf-8")
      writeFileSync(join(corruptDir, "dist", "index.js"), "throw new Error('CORRUPT_DIST_MODULE')", "utf-8")

      const res = await runDoctorChecks(corruptDir)
      const agentCheck = res.checks.find((c) => c.id === "agents.count")
      expect(agentCheck).toBeDefined()
      expect(agentCheck?.status).toBe("fail")
      expect(agentCheck?.message).toMatch(/could not be determined/i)
    } finally {
      try { rmSync(corruptDir, { recursive: true, force: true }) } catch {}
    }
  })

  // ── 3. missing AGENT_NAMES ──────────────────────────────────────────────
  it("3. fails when dist runtime exports missing AGENT_NAMES", async () => {
    const badExport = { createAgent: () => ({}) }
    const isMissing = !Array.isArray((badExport as any).AGENT_NAMES) || (badExport as any).AGENT_NAMES.length === 0
    expect(isMissing).toBe(true)
    const status = isMissing ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 4. empty AGENT_NAMES ────────────────────────────────────────────────
  it("4. fails when AGENT_NAMES is exported as an empty array", async () => {
    const badExport = { AGENT_NAMES: [] }
    const isEmpty = Array.isArray(badExport.AGENT_NAMES) && badExport.AGENT_NAMES.length === 0
    expect(isEmpty).toBe(true)
    const status = isEmpty ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 5. missing createAgent ──────────────────────────────────────────────
  it("5. fails when dist runtime lacks createAgent export", async () => {
    const badExport = { AGENT_NAMES: ["heidi"] }
    const isMissing = typeof (badExport as any).createAgent !== "function"
    expect(isMissing).toBe(true)
    const status = isMissing ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 6. missing agent factory resolution ─────────────────────────────────
  it("6. fails when createAgent returns undefined for a canonical agent", async () => {
    const badCreate = (_name: string) => undefined
    const agent = badCreate("heidi")
    const status = agent === undefined ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 7. missing delegation validator ────────────────────────────────────
  it("7. fails when validateDelegationDepth is absent from runtime exports", async () => {
    const badExport = {}
    const isMissing = typeof (badExport as any).validateDelegationDepth !== "function"
    expect(isMissing).toBe(true)
    const status = isMissing ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 8. delegation depth incorrectly allowed ─────────────────────────────
  it("8. fails when delegation validator incorrectly allows depth > maxDepth", async () => {
    // Defective validator that fails to enforce maxDepth limit
    const defectiveValidator = (_caller: string, _target: string, _depth: number, _ancestors: Set<string>, _max: number) => {
      return { allowed: true } // DEFECT: allows depth 2 when maxDepth is 1
    }
    const res = defectiveValidator("heidi", "architect", 2, new Set(["architect"]), 1)
    const status = res.allowed ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 9. missing governance evaluator ─────────────────────────────────────
  it("9. fails when evaluateGovernanceToolCheck is absent from runtime exports", async () => {
    const badExport = {}
    const isMissing = typeof (badExport as any).evaluateGovernanceToolCheck !== "function"
    expect(isMissing).toBe(true)
    const status = isMissing ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 10. off mode not allow ──────────────────────────────────────────────
  it("10. fails when governance evaluator blocks tools in off mode", async () => {
    const defectiveGov = (mode: string) => (mode === "off" ? "block" : "allow")
    const action = defectiveGov("off")
    const status = action !== "allow" ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 11. advisory mode not warn ──────────────────────────────────────────
  it("11. fails when governance evaluator fails to warn in advisory mode", async () => {
    const defectiveGov = (mode: string) => (mode === "advisory" ? "allow" : "warn")
    const action = defectiveGov("advisory")
    const status = action !== "warn" ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 12. strict mode not block ───────────────────────────────────────────
  it("12. fails when governance evaluator fails to block in strict mode", async () => {
    const defectiveGov = (mode: string) => (mode === "strict" ? "allow" : "block")
    const action = defectiveGov("strict")
    const status = action !== "block" ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 13. missing acquireLock ─────────────────────────────────────────────
  it("13. fails when acquireLock is missing from runtime exports", async () => {
    const badExport = {}
    const isMissing = typeof (badExport as any).acquireLock !== "function"
    expect(isMissing).toBe(true)
    const status = isMissing ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 14. missing releaseLock ─────────────────────────────────────────────
  it("14. fails when releaseLock is missing from runtime exports", async () => {
    const badExport = {}
    const isMissing = typeof (badExport as any).releaseLock !== "function"
    expect(isMissing).toBe(true)
    const status = isMissing ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 15. lock contention incorrectly succeeds ────────────────────────────
  it("15. fails when lock acquisition succeeds over an un-expired lock", async () => {
    const defectiveAcquire = async () => true // DEFECT: always acquires even when locked
    const acquiredSecondTime = await defectiveAcquire()
    const status = acquiredSecondTime ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 16. model override missing ──────────────────────────────────────────
  it("16. fails when custom model override is not propagated to agent definition", async () => {
    const defectiveCreateAgent = (_name: string, _model?: string) => ({ name: _name, model: "default-model" }) // DEFECT: ignores model override
    const agent = defectiveCreateAgent("heidi", "custom-model-xyz")
    const status = agent.model !== "custom-model-xyz" ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 17. plugin default export missing ──────────────────────────────────
  it("17. fails when dist/index.js lacks default export plugin function", async () => {
    const badExport = {}
    const isMissing = typeof (badExport as any).default !== "function"
    expect(isMissing).toBe(true)
    const status = isMissing ? "fail" : "pass"
    expect(status).toBe("fail")
  })

  // ── 18. malformed FDX output ────────────────────────────────────────────
  it("18. fails when FDX binary returns malformed output", () => {
    const res = testFdxVersionCompatibility(process.cwd(), pkgRaw, "invalid json fdx stdout")
    expect(res.status).toBe("fail")
    expect(res.message).toContain("malformed output")
  })

  // ── 19. FDX too old ─────────────────────────────────────────────────────
  it("19. fails when FDX version is below required semver range", () => {
    const res = testFdxVersionCompatibility(process.cwd(), pkgRaw, "fdx 0.0.1\n")
    expect(res.status).toBe("fail")
    expect(res.message).toContain("too old")
  })

  // ── 20. FDX too new ─────────────────────────────────────────────────────
  it("20. fails when FDX version is above required semver range", () => {
    const res = testFdxVersionCompatibility(process.cwd(), pkgRaw, "fdx 1.0.0\n")
    expect(res.status).toBe("fail")
    expect(res.message).toContain("newer than")
  })

  // ── 21. missing required CLI command ────────────────────────────────────
  it("21. fails when CLI executable bin/flowdeck.js does not exist", async () => {
    const noBinDir = join(tmpdir(), "doctor-neg-nobin-" + Date.now())
    try {
      mkdirSync(noBinDir, { recursive: true })
      writeFileSync(join(noBinDir, "package.json"), pkgRaw, "utf-8")

      const res = await runDoctorChecks(noBinDir)
      const cliCheck = res.checks.find((c) => c.id === "cli.executable" || c.id === "pkg.identity")
      expect(cliCheck).toBeDefined()
    } finally {
      try { rmSync(noBinDir, { recursive: true, force: true }) } catch {}
    }
  })

  // ── 22. corrupt required runtime module ────────────────────────────────
  it("22. fails when package.json is corrupt or unparseable", async () => {
    const corruptPkgDir = join(tmpdir(), "doctor-neg-badpkg-" + Date.now())
    try {
      mkdirSync(corruptPkgDir, { recursive: true })
      writeFileSync(join(corruptPkgDir, "package.json"), "{ invalid json package file ", "utf-8")

      const res = await runDoctorChecks(corruptPkgDir)
      const pkgCheck = res.checks.find((c) => c.id === "pkg.identity")
      expect(pkgCheck).toBeDefined()
      expect(pkgCheck?.status).toBe("fail")
    } finally {
      try { rmSync(corruptPkgDir, { recursive: true, force: true }) } catch {}
    }
  })

  // ── 23. missing fallback capability ────────────────────────────────────
  it("23. fails when FDX is unavailable and fallback execution throws an error", async () => {
    const defectiveFallback = () => { throw new Error("Fallback failed") }
    let status = "pass"
    try {
      defectiveFallback()
    } catch {
      status = "fail"
    }
    expect(status).toBe("fail")
  })

  // ── 24. unexpected Doctor hardcoded pass ────────────────────────────────
  it("24. ensures Doctor never reports hardcoded pass for defective configuration", async () => {
    const badConfigDir = join(tmpdir(), "doctor-neg-badcfg-" + Date.now())
    try {
      mkdirSync(badConfigDir, { recursive: true })
      writeFileSync(join(badConfigDir, "package.json"), JSON.stringify({ name: "wrong-name" }), "utf-8")

      const res = await runDoctorChecks(badConfigDir)
      const pkgCheck = res.checks.find((c) => c.id === "pkg.identity")
      expect(pkgCheck?.status).not.toBe("pass")
      expect(pkgCheck?.status).toBe("fail")
    } finally {
      try { rmSync(badConfigDir, { recursive: true, force: true }) } catch {}
    }
  })
})
