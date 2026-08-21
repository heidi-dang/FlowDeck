import { describe, it, expect } from "bun:test"
import { detectBrowserCapability, findAgentBrowserBinary } from "../src/browser/capability"
import { writeFileSync, unlinkSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("Browser Capability Detection Unit Tests", () => {
  it("finds custom binary path when it exists", () => {
    const dummyPath = join(tmpdir(), `dummy-bin-${Date.now()}`)
    writeFileSync(dummyPath, "#!/bin/sh\necho 1.0.0\n")
    try {
      expect(findAgentBrowserBinary(dummyPath)).toBe(dummyPath)
      expect(findAgentBrowserBinary("/non/existent/path/agent-browser")).toBeNull()
    } finally {
      try {
        unlinkSync(dummyPath)
      } catch {}
    }
  })

  it("finds binary from environment variable", () => {
    const dummyPath = join(tmpdir(), `dummy-env-bin-${Date.now()}`)
    writeFileSync(dummyPath, "#!/bin/sh\necho 1.0.0\n")
    const origEnv = process.env.FLOWDECK_AGENT_BROWSER_PATH
    try {
      process.env.FLOWDECK_AGENT_BROWSER_PATH = dummyPath
      expect(findAgentBrowserBinary()).toBe(dummyPath)
    } finally {
      process.env.FLOWDECK_AGENT_BROWSER_PATH = origEnv
      try {
        unlinkSync(dummyPath)
      } catch {}
    }
  })

  it("detects browser capability with custom binary", async () => {
    const dummyPath = join(tmpdir(), `dummy-cap-bin-${Date.now()}`)
    writeFileSync(dummyPath, "#!/bin/sh\necho 2.0.0\n")
    try {
      const res = await detectBrowserCapability({ customBinaryPath: dummyPath })
      expect(res.available).toBe(true)
      if (res.available) {
        expect(res.binaryPath).toBe(dummyPath)
      }
    } finally {
      try {
        unlinkSync(dummyPath)
      } catch {}
    }
  })

  it("returns unavailable when binary is missing", async () => {
    const origPath = process.env.PATH
    const origEnv = process.env.FLOWDECK_AGENT_BROWSER_PATH
    try {
      process.env.PATH = ""
      delete process.env.FLOWDECK_AGENT_BROWSER_PATH
      const res = await detectBrowserCapability({ customBinaryPath: "/non/existent/browser" })
      expect(res.available).toBe(false)
      if (!res.available) {
        expect(res.reason).toBe("agent-browser-missing")
      }
    } finally {
      process.env.PATH = origPath
      process.env.FLOWDECK_AGENT_BROWSER_PATH = origEnv
    }
  })
})
