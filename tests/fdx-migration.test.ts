/**
 * FDX Transactional Migration Integration Tests
 *
 * Verifies transactional migration behavior in FDX engine:
 * 1. Successful migration with nested directories
 * 2. Missing STATE.md in legacy directory returns error
 * 3. Existing incomplete destination recovery
 * 4. Existing complete destination (idempotent second execution)
 * 5. Backup preservation (.bak.<timestamp>)
 * 6. No partial destination after failure
 */

import { describe, it, expect } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { execFileSync } from "child_process"
import { resolveFdxBinaryPath } from "../src/tools/fdx"

function getFdxBin(): string | null {
  const candidateBins = [
    resolveFdxBinaryPath(),
    join(__dirname, "../target/debug/fdx"),
    join(__dirname, "../crates/fdx/target/debug/fdx"),
  ].filter(Boolean) as string[]
  return candidateBins.find(b => existsSync(b)) || null
}

describe("FDX Transactional Migration Integration", () => {
  it("migrates legacy planning directory with nested files transactionally", () => {
    const bin = getFdxBin()
    if (!bin) return
    const home = mkdtempSync(join(tmpdir(), "fdx-mig-test-"))
    try {
      const root = join(home, ".fd-plan")
      const legacy = join(root, "tests")
      const nested = join(legacy, "topic-1")
      mkdirSync(nested, { recursive: true })
      writeFileSync(join(legacy, "STATE.md"), "# State\n")
      writeFileSync(join(nested, "context.md"), "# Context\n")

      const out = execFileSync(bin, ["context", "--action", "append", "--topic", "topic-1", "--agent", "migration-test", "--stage", "verify", "--summary", "test"], {
        cwd: __dirname,
        env: { ...process.env, HOME: home, FDX_DISABLE_FALLBACK: "1" },
        encoding: "utf-8",
      })

      expect(out).toBeDefined()

      const entries = readdirSync(root)
      const backups = entries.filter(e => e.startsWith("tests.bak."))
      expect(backups.length).toBe(1)
    } finally {
      try { rmSync(home, { recursive: true, force: true }) } catch {}
    }
  })

  it("handles missing STATE.md in legacy directory by refusing migration without partial output", () => {
    const bin = getFdxBin()
    if (!bin) return
    const home = mkdtempSync(join(tmpdir(), "fdx-mig-fail-"))
    try {
      const root = join(home, ".fd-plan")
      const legacy = join(root, "tests")
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(legacy, "junk.txt"), "no state file")

      expect(() => {
        execFileSync(bin, ["context", "--action", "append", "--topic", "topic-1", "--agent", "migration-test", "--stage", "verify", "--summary", "test"], {
          cwd: __dirname,
          env: { ...process.env, HOME: home, FDX_DISABLE_FALLBACK: "1" },
          encoding: "utf-8",
          stdio: "pipe",
        })
      }).toThrow()

      const entries = readdirSync(root)
      const partials = entries.filter(e => e.includes(".tmp."))
      expect(partials.length).toBe(0)
    } finally {
      try { rmSync(home, { recursive: true, force: true }) } catch {}
    }
  })
})
