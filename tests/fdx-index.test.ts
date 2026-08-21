import { describe, expect, it } from "bun:test"
import { FdxWorkspaceIndex } from "../src/services/fdx-index"
import { FdxDaemon, fdxDaemonRequest } from "../src/services/fdx-daemon"
import { configureFdxNextRuntime, fdxImpactTool, fdxOutlineTool, fdxSearchTool, checkFdxAvailability } from "../src/tools/fdx"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("persistent FDX runtime", () => {
  it("reconstructs daemon state after restart and preserves workspace isolation", async () => {
    const root = mkdtempSync(join(tmpdir(), "flowdeck-fdx-daemon-persist-"))
    const a = join(root, "a")
    const b = join(root, "b")
    mkdirSync(a); mkdirSync(b)
    const socket = join(root, "fdx.sock")
    const stateFile = join(root, "state.json")
    const daemon1 = new FdxDaemon({ socketPath: socket, workspaceRoot: root, stateFile })
    try {
      await daemon1.start()
      expect((await fdxDaemonRequest<unknown>(socket, { method: "put", workspace: a, key: "outline", value: { symbols: ["A"] } }, () => null)).source).toBe("daemon")
    } finally { await daemon1.stop() }
    const daemon2 = new FdxDaemon({ socketPath: socket, workspaceRoot: root, stateFile })
    try {
      await daemon2.start()
      expect((await fdxDaemonRequest<unknown>(socket, { method: "get", workspace: a, key: "outline" }, () => null)).value).toEqual({ symbols: ["A"] })
      expect((await fdxDaemonRequest(socket, { method: "get", workspace: b, key: "outline" }, () => "fallback")).value).toBeUndefined()
      expect((await fdxDaemonRequest(socket, { method: "get", workspace: join(root, "outside") }, () => "safe")).value).toBe("safe")
    } finally { await daemon2.stop(); rmSync(root, { recursive: true, force: true }) }
  })

  it("incrementally refreshes symbols, deletes removed files, and survives restart", () => {
    const root = mkdtempSync(join(tmpdir(), "flowdeck-fdx-index-"))
    const source = join(root, "src")
    mkdirSync(source)
    const stateFile = join(root, "index.json")
    try {
      writeFileSync(join(source, "a.ts"), "export function Alpha() { return 1 }\n")
      writeFileSync(join(source, "b.ts"), "export class Beta {}\n")
      const first = new FdxWorkspaceIndex({ stateFile, maxFiles: 10 })
      expect(first.refresh(root).files.map(file => file.path).filter(p => !p.endsWith("index.json"))).toEqual(["src/a.ts", "src/b.ts"])
      expect(first.symbols(root, "alpha")).toEqual([{ path: "src/a.ts", symbol: "Alpha" }])
      writeFileSync(join(source, "a.ts"), "export function Gamma() { return 123456 }\n")
      expect(first.symbols(root, "gamma")).toEqual([{ path: "src/a.ts", symbol: "Gamma" }])
      unlinkSync(join(source, "b.ts"))
      expect(first.refresh(root).files.map(file => file.path).filter(p => !p.endsWith("index.json"))).toEqual(["src/a.ts"])
      const restarted = new FdxWorkspaceIndex({ stateFile, maxFiles: 10 })
      expect(restarted.get(root)?.files.map(file => file.path).filter(p => !p.endsWith("index.json"))).toEqual(["src/a.ts"])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it("connects the persistent index to the existing tool surface when native FDX is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "flowdeck-fdx-tools-"))
    const source = join(root, "src")
    mkdirSync(source)
    writeFileSync(join(source, "alpha.ts"), "export function Alpha() { return 1 }\n")
    const previousBinary = process.env.FDX_BINARY_PATH
    try {
      process.env.FDX_BINARY_PATH = join(root, "missing-fdx")
      checkFdxAvailability(true)
      const index = new FdxWorkspaceIndex({ stateFile: join(root, "index.json") })
      configureFdxNextRuntime({ workspace: root, index })
      const outline = JSON.parse(await fdxOutlineTool.execute({ paths: ["src"], format: "json" }, {} as any) as string)
      expect(outline.source).toBe("persistent-index")
      expect(outline.files).toEqual([{ path: "src/alpha.ts", symbols: ["Alpha"] }])
      const search = JSON.parse(await fdxSearchTool.execute({ query: "alpha", format: "json" }, {} as any) as string)
      expect(search.matches).toEqual([{ path: "src/alpha.ts", symbol: "Alpha" }])
      writeFileSync(join(source, "beta.ts"), "import { Alpha } from \"src/alpha.ts\"\nexport function Beta() { return Alpha() }\n")
      // Freshness model: a write/edit invalidates the changed path and the
      // resident snapshot is refreshed incrementally (no hidden full rescan).
      index.refreshChanged(root, ["src/beta.ts"])
      const impact = JSON.parse(await fdxImpactTool.execute({ files: ["src/alpha.ts"], format: "json" }, {} as any) as string)
      expect(impact.affectedPaths).toEqual(["src/alpha.ts", "src/beta.ts"])
    } finally {
      configureFdxNextRuntime()
      if (previousBinary === undefined) delete process.env.FDX_BINARY_PATH
      else process.env.FDX_BINARY_PATH = previousBinary
      checkFdxAvailability(true)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("serves bounded search, outline, and impact through the optional daemon protocol", async () => {
    const root = mkdtempSync(join(tmpdir(), "flowdeck-fdx-code-daemon-"))
    const source = join(root, "src")
    mkdirSync(source)
    writeFileSync(join(source, "alpha.ts"), "export function Alpha() { return 1 }\n")
    writeFileSync(join(source, "beta.ts"), "import { Alpha } from \"src/alpha.ts\"\nexport function Beta() { return Alpha() }\n")
    const socket = join(root, "fdx.sock")
    const index = new FdxWorkspaceIndex({ stateFile: join(root, "index.json"), maxFiles: 10 })
    const daemon = new FdxDaemon({ socketPath: socket, workspaceRoot: root, index })
    try {
      await daemon.start()
      const search = await fdxDaemonRequest<Array<{ path: string; symbol: string }>>(socket, { method: "search", workspace: root, query: "alpha" }, () => [])
      expect(search.source).toBe("daemon")
      expect(search.value).toEqual([{ path: "src/alpha.ts", symbol: "Alpha" }])
      const outline = await fdxDaemonRequest<Array<{ path: string; symbols: string[] }>>(socket, { method: "outline", workspace: root, paths: ["src"] }, () => [])
      expect(outline.value).toHaveLength(2)
      const impact = await fdxDaemonRequest<{ affectedPaths: string[] }>(socket, { method: "impact", workspace: root, paths: ["src/alpha.ts"] }, () => ({ affectedPaths: [] }))
      expect(impact.value.affectedPaths).toEqual(["src/alpha.ts", "src/beta.ts"])
    } finally {
      await daemon.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
