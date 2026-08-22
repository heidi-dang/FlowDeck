import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawn, type ChildProcess } from "node:child_process"

const FDX_BIN = resolve(process.cwd(), "target/debug/fdx")

describe("P0 Security: Rust FDX Daemon repository jail containment", () => {
  let repoDir: string
  let outsideDir: string
  let outsideSecretFile: string
  let daemonProcess: ChildProcess | null = null

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "fdx-daemon-repo-"))
    outsideDir = mkdtempSync(join(tmpdir(), "fdx-daemon-outside-"))

    outsideSecretFile = join(outsideDir, "secret.txt")
    writeFileSync(outsideSecretFile, "SECRET_OUTSIDE_REPO", "utf-8")

    const srcDir = join(repoDir, "src")
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, "main.ts"), "export function hello() { return 'world'; }", "utf-8")
  })

  afterEach(async () => {
    if (daemonProcess && !daemonProcess.killed) {
      daemonProcess.kill("SIGKILL")
    }
    try { rmSync(repoDir, { recursive: true, force: true }) } catch {}
    try { rmSync(outsideDir, { recursive: true, force: true }) } catch {}
  })

  async function sendIpcRequest(op: string, args: Record<string, unknown>): Promise<{ id: string; ok: boolean; value?: any; error?: string }> {
    if (!existsSync(FDX_BIN)) {
      throw new Error(`FDX binary not found at ${FDX_BIN}. Build with cargo build first.`)
    }

    if (!daemonProcess || daemonProcess.killed) {
      daemonProcess = spawn(FDX_BIN, ["serve", "--root", repoDir], {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: repoDir,
      })
    }

    const reqId = `req_${Math.random().toString(36).slice(2, 8)}`
    const payload = JSON.stringify({ id: reqId, op, args }) + "\n"

    return new Promise((resolveReq, rejectReq) => {
      const timeout = setTimeout(() => {
        rejectReq(new Error("Daemon response timeout"))
      }, 5000)

      const onLine = (line: string) => {
        try {
          const parsed = JSON.parse(line.trim())
          if (parsed.id === reqId) {
            clearTimeout(timeout)
            daemonProcess?.stdout?.removeListener("data", onData)
            resolveReq(parsed)
          }
        } catch {}
      }

      let buf = ""
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8")
        let idx: number
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          onLine(line)
        }
      }

      daemonProcess?.stdout?.on("data", onData)
      daemonProcess?.stdin?.write(payload)
    })
  }

  it("serves read requests within the authoritative repository root", async () => {
    const res = await sendIpcRequest("read", { path: "src/main.ts" })
    expect(res.ok).toBe(true)
    expect(res.value?.text).toContain("hello")
  })

  it("rejects read requests escaping repository root via ../ traversal", async () => {
    const res = await sendIpcRequest("read", { path: "../../secret.txt" })
    expect(res.ok).toBe(false)
    expect(res.error).toBeDefined()
  })

  it("rejects read requests to /etc/passwd or outside absolute path", async () => {
    const res = await sendIpcRequest("read", { path: "/etc/passwd" })
    expect(res.ok).toBe(false)
    expect(res.error).toBeDefined()

    const res2 = await sendIpcRequest("read", { path: outsideSecretFile })
    expect(res2.ok).toBe(false)
    expect(res2.error).toBeDefined()
  })

  it("rejects read requests through symlinks escaping repository root", async () => {
    const symlinkPath = join(repoDir, "src", "escape_symlink.ts")
    try {
      symlinkSync(outsideSecretFile, symlinkPath)
    } catch {
      return
    }

    const res = await sendIpcRequest("read", { path: "src/escape_symlink.ts" })
    expect(res.ok).toBe(false)
    expect(res.error).toBeDefined()
  })

  it("rejects search requests targeting outside repository paths", async () => {
    const res = await sendIpcRequest("search", { pattern: "SECRET", paths: ["../../"] })
    expect(res.ok).toBe(false)
    expect(res.error).toBeDefined()
  })

  it("rejects outline requests targeting outside repository paths", async () => {
    const res = await sendIpcRequest("outline", { paths: ["/etc", "../../"] })
    expect(res.ok).toBe(false)
    expect(res.error).toBeDefined()
  })

  it("rejects impact requests targeting outside repository paths", async () => {
    const res = await sendIpcRequest("impact", { paths: ["/etc/passwd", "../../outside"] })
    expect(res.ok).toBe(false)
    expect(res.error).toBeDefined()
  })
})
