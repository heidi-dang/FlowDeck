import { describe, it, expect } from "bun:test"
import { RepoLeaseCoordinator } from "../src/services/repo-lease-coordinator"
import { tmpdir } from "os"
import { join } from "path"
import { mkdtempSync, rmSync } from "fs"

function dir() { const d = mkdtempSync(join(tmpdir(), "fd-lease-")); return d }
function clean(d: string) { try { rmSync(d, { recursive: true, force: true }) } catch {} }

describe("REPO SESSION COORDINATION (leases)", () => {
  it("read-only sessions never need a lease and can coexist", () => {
    const d = dir()
    const c = new RepoLeaseCoordinator({ stateDir: join(d, ".flowdeck", "leases") })
    const repo = "repo-x"
    expect(c.isSafeToMutate(repo)).toBe(true)
    expect(c.getMutatingOwner(repo)).toBeNull()
    clean(d)
  })
  it("one mutating owner acquires exclusive lease; second waits then fails safely with redirect", async () => {
    const d = dir()
    const c = new RepoLeaseCoordinator({ stateDir: join(d, ".flowdeck", "leases"), maxWaitMs: 300 })
    const repo = "repo-x"
    await c.acquireMutatingLease(repo, "session-A")
    expect(c.getMutatingOwner(repo)).toBe("session-A")
    let thrown = ""
    try { await c.acquireMutatingLease(repo, "session-B") } catch (err: any) { thrown = err?.message ?? String(err) }
    expect(thrown).toContain("RepoMutatingLeaseUnavailable_Redirect")
    expect(c.getMutatingOwner(repo)).toBe("session-A")
    c.releaseMutatingLease(repo, "session-A")
    expect(c.getMutatingOwner(repo)).toBeNull()
    await c.acquireMutatingLease(repo, "session-B")
    expect(c.getMutatingOwner(repo)).toBe("session-B")
    clean(d)
  })
  it("crashed lease is recovered (stale heartbeat reclaimed)", async () => {
    const d = dir()
    const c = new RepoLeaseCoordinator({ stateDir: join(d, ".flowdeck", "leases"), leaseTtlMs: 50, recheckMs: 20, maxWaitMs: 200 })
    const repo = "repo-crash"
    await c.acquireMutatingLease(repo, "session-A")
    await new Promise(r => setTimeout(r, 120))
    expect(c.getMutatingOwner(repo)).toBeNull()
    await c.acquireMutatingLease(repo, "session-B")
    expect(c.getMutatingOwner(repo)).toBe("session-B")
    clean(d)
  })
})

describe("TASK PHASE ISOLATION", () => {
  it("new manual task resets control state but preserves session ancestry", () => {
    const m = new (require("../src/services/task-phase-manager").TaskPhaseManager)()
    const first = m.beginNewTaskPhase("ses-1", "task-a", ["audit"])
    expect(first.phase).toBe(1)
    expect(first.resetLoopIncidents).toBe(true)
    expect(first.resetSemanticConvergence).toBe(true)
    expect(first.resetWatchdog).toBe(true)
    const second = m.beginNewTaskPhase("ses-1", "task-b", ["implement"])
    expect(second.phase).toBe(2)
    expect(second.preserveSessionAncestry).toBe(true)
    expect(second.preserveCoordinatorProvenance).toBe(true)
  })
})

describe("TOOL FAST LANE & SHELL REWRITE", () => {
  it("read-only fast path preserves governance for mutating tools (full path kept)", () => {
    const f = require("../src/services/tool-fast-lane")
    expect(f.classifyFastLane("fdx-read").category).toBe("fast_read_only")
    expect(f.classifyFastLane("grep").category).toBe("fast_read_only")
    expect(f.classifyFastLane("write").category).toBe("mutating_full_governance")
    expect(f.classifyFastLane("bash").category).toBe("mutating_full_governance")
  })
  it("shell rewrite preserves semantics for cat/sed/grep/git; uncertain falls back", () => {
    const f = require("../src/services/tool-fast-lane")
    const cat = f.rewriteShellCommand("cat src/index.ts")
    expect(cat).not.toBeNull()
    expect(cat.adapter).toBe("file-read")
    const sed = f.rewriteShellCommand("sed -n '1140,1146p' src/index.ts")
    expect(sed).not.toBeNull()
    expect(sed.to).toContain("offset=1140")
    const grep = f.rewriteShellCommand("grep -n 'TODO' src/app.ts")
    expect(grep).not.toBeNull()
    expect(grep.adapter).toBe("file-grep")
    const gst = f.rewriteShellCommand("git status")
    expect(gst).not.toBeNull()
    expect(gst.adapter).toBe("git-status")
    expect(f.rewriteShellCommand("rm -rf node_modules")).toBeNull()
    expect(f.rewriteShellCommand("echo hello | base64")).toBeNull()
  })
  it("ls rewrite", () => {
    const f = require("../src/services/tool-fast-lane")
    const ls = f.rewriteLsCommand("ls src")
    expect(ls).not.toBeNull()
    expect(ls.adapter).toBe("dir-list")
  })
})
