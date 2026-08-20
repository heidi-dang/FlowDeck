/**
 * FDX Native Wrapper Integration Tests
 *
 * Verifies production exported tool functions in `src/tools/fdx.ts`:
 * 1. FDX_BINARY_PATH is the binary used when configured.
 * 2. PATH lookup is bypassed when an explicit binary is configured.
 * 3. Missing configured binary throws when fallback is disabled.
 * 4. Native non-zero exit propagates when fallback is disabled.
 * 5. No result contains a fallback marker when native execution runs.
 */

import { describe, it, expect } from "bun:test"
import { existsSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"
import {
  resolveFdxBinaryPath,
  getFdxAvailabilityStatus,
  fdxReadTool,
} from "../src/tools/fdx"

describe("FDX Native Wrapper & Tool Integration", () => {
  const resolved = resolveFdxBinaryPath()
  const nativeBin = (resolved && resolved !== "fdx") ? resolved : join(__dirname, "../crates/fdx/target/debug/fdx")

  it("proves FDX_BINARY_PATH is used and PATH lookup is bypassed when explicit binary is set", () => {
    if (!existsSync(nativeBin)) return

    const origBinPath = process.env.FDX_BINARY_PATH
    try {
      process.env.FDX_BINARY_PATH = nativeBin
      const status = getFdxAvailabilityStatus(true)
      expect(status.available).toBe(true)
      expect(status.binary).toBe(nativeBin)
    } finally {
      process.env.FDX_BINARY_PATH = origBinPath
      getFdxAvailabilityStatus(true)
    }
  })

  it("throws when missing configured binary and fallback is disabled", async () => {
    const origBinPath = process.env.FDX_BINARY_PATH
    const origFallback = process.env.FDX_DISABLE_FALLBACK
    try {
      process.env.FDX_BINARY_PATH = join(tmpdir(), "nonexistent-fdx-binary-12345")
      process.env.FDX_DISABLE_FALLBACK = "1"
      getFdxAvailabilityStatus(true)

      let threw = false
      try {
        await fdxReadTool.execute({ file: "package.json", mode: "prototype" }, { sessionID: "s1", messageID: "m1" } as any)
      } catch (err: any) {
        threw = true
        expect(err.message).toContain("Fallback Disabled")
      }
      expect(threw).toBe(true)
    } finally {
      process.env.FDX_BINARY_PATH = origBinPath
      process.env.FDX_DISABLE_FALLBACK = origFallback
      getFdxAvailabilityStatus(true)
    }
  })

  it("propagates native non-zero exit when fallback is disabled", async () => {
    if (!existsSync(nativeBin)) return
    const origBinPath = process.env.FDX_BINARY_PATH
    const origFallback = process.env.FDX_DISABLE_FALLBACK
    try {
      process.env.FDX_BINARY_PATH = nativeBin
      process.env.FDX_DISABLE_FALLBACK = "1"
      getFdxAvailabilityStatus(true)

      let threw = false
      try {
        await fdxReadTool.execute({ file: "nonexistent-file-99999.ts" }, { sessionID: "s1", messageID: "m1" } as any)
      } catch (err: any) {
        threw = true
        expect(err.message.length).toBeGreaterThan(0)
      }
      expect(threw).toBe(true)
    } finally {
      process.env.FDX_BINARY_PATH = origBinPath
      process.env.FDX_DISABLE_FALLBACK = origFallback
      getFdxAvailabilityStatus(true)
    }
  })

  it("executes production tools natively without fallback markers when fallback is disabled", async () => {
    if (!existsSync(nativeBin)) return
    const origBinPath = process.env.FDX_BINARY_PATH
    const origFallback = process.env.FDX_DISABLE_FALLBACK
    try {
      process.env.FDX_BINARY_PATH = nativeBin
      process.env.FDX_DISABLE_FALLBACK = "1"
      getFdxAvailabilityStatus(true)

      const result = await fdxReadTool.execute(
        { file: "package.json", mode: "raw", limit: 10 },
        { sessionID: "s1", messageID: "m1", directory: resolve(__dirname, "..") } as any
      )
      expect(typeof result).toBe("string")
      expect(result).not.toContain("[TypeScript Fallback]")
      expect(result).not.toContain("Fall back to TypeScript")
    } finally {
      process.env.FDX_BINARY_PATH = origBinPath
      process.env.FDX_DISABLE_FALLBACK = origFallback
      getFdxAvailabilityStatus(true)
    }
  })
})
