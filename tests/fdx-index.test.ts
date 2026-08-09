import { describe, expect, it } from "bun:test"
import { FdxWorkspaceIndex } from "../src/services/fdx-index"
import { FdxDaemon, fdxDaemonRequest } from "../src/services/fdx-daemon"
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
      expect(first.refresh(root).files.map(file => file.path)).toEqual(["src/a.ts", "src/b.ts"])
      expect(first.symbols(root, "alpha")).toEqual([{ path: "src/a.ts", symbol: "Alpha" }])
      writeFileSync(join(source, "a.ts"), "export function Gamma() { return 123456 }\n")
      expect(first.symbols(root, "gamma")).toEqual([{ path: "src/a.ts", symbol: "Gamma" }])
      unlinkSync(join(source, "b.ts"))
      expect(first.refresh(root).files.map(file => file.path)).toEqual(["src/a.ts"])
      const restarted = new FdxWorkspaceIndex({ stateFile, maxFiles: 10 })
      expect(restarted.get(root)?.files.map(file => file.path)).toEqual(["src/a.ts"])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
