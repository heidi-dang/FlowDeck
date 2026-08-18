import { describe, it, expect, afterAll } from "bun:test"
import { FdxWorkspaceIndex } from "../src/services/fdx-index"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const roots: string[] = []

function makeRoot(): { root: string; source: string } {
  const root = mkdtempSync(join(tmpdir(), "fdx-norescan-"))
  const source = join(root, "src")
  mkdirSync(source)
  writeFileSync(join(source, "a.ts"), "export function Alpha() { return 1 }\n")
  writeFileSync(join(source, "b.ts"), "export class Beta {}\n")
  roots.push(root)
  return { root, source }
}

/**
 * Counting adapter: the index's only recursive workspace walk happens inside
 * refresh() (via discover -> readdirSync). Wrapping refresh lets us assert a
 * warm query issues zero recursive scans.
 */
function countingIndex(root: string): { idx: FdxWorkspaceIndex; scans: () => number } {
  const idx = new FdxWorkspaceIndex({ stateFile: join(root, "index.json"), maxFiles: 50 })
  let scans = 0
  const original = idx.refresh.bind(idx)
  ;(idx as unknown as { refresh: (w: string) => ReturnType<typeof idx.refresh> }).refresh = (w: string) => {
    scans++
    return original(w)
  }
  return { idx, scans: () => scans }
}

afterAll(() => {
  for (const root of roots) {
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  }
})

describe("FdxWorkspaceIndex — warm queries never rescan the workspace", () => {
  it("cold query initializes the snapshot exactly once (one refresh)", () => {
    const { root } = makeRoot()
    const { idx, scans } = countingIndex(root)
    idx.querySymbols(root, "alpha")
    expect(scans()).toBe(1)
    expect(idx.querySymbols(root, "alpha")).toEqual([{ path: "src/a.ts", symbol: "Alpha" }])
  })

  it("subsequent warm queries perform zero recursive workspace scans", () => {
    const { root } = makeRoot()
    const { idx, scans } = countingIndex(root)
    idx.querySymbols(root, "alpha") // cold init: 1 scan
    expect(scans()).toBe(1)
    idx.querySymbols(root, "alpha") // warm
    idx.querySymbols(root, "beta") // warm
    idx.querySymbols(root, "missing") // warm, no match
    expect(scans()).toBe(1) // still exactly one full walk, ever
  })

  it("edit + invalidate + refreshChanged refreshes ONLY the changed file, with no stale data", () => {
    const { root, source } = makeRoot()
    const { idx, scans } = countingIndex(root)
    idx.queryOutline(root) // init
    const afterInit = scans()

    // edit a.ts so it defines Gamma instead of Alpha
    writeFileSync(join(source, "a.ts"), "export function Gamma() { return 9 }\n")
    idx.invalidate(root, ["src/a.ts"])
    expect(idx.get(root)!.files.find((f) => f.path === "src/a.ts")).toBeUndefined()

    idx.refreshChanged(root, ["src/a.ts"])
    // refreshChanged must NOT trigger a full workspace walk
    expect(scans()).toBe(afterInit)
    expect(idx.querySymbols(root, "gamma")).toEqual([{ path: "src/a.ts", symbol: "Gamma" }])
    // no stale Alpha in the refreshed file
    expect(idx.querySymbols(root, "alpha")).toEqual([])
    // untouched sibling is preserved
    expect(idx.querySymbols(root, "beta")).toEqual([{ path: "src/b.ts", symbol: "Beta" }])
  })

  it("warm outline and impact queries also perform zero scans after init", () => {
    const { root } = makeRoot()
    const { idx, scans } = countingIndex(root)
    idx.querySymbols(root, "alpha") // init
    const afterInit = scans()

    const outline = idx.queryOutline(root)
    expect(outline.some((f) => f.path === "src/a.ts" && f.symbols.includes("Alpha"))).toBe(true)

    const sub = idx.queryOutline(root, ["src"])
    expect(sub).toHaveLength(2)

    const impact = idx.queryImpact(root, ["src/b.ts"])
    expect(impact.changedPaths).toContain("src/b.ts")

    expect(scans()).toBe(afterInit)
  })
})
