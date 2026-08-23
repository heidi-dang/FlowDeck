import { describe, it, expect } from "vitest"
import { execFileSync, execSync } from "node:child_process"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("P1 Packaging: npm package dependency closure", () => {
  it("packs tarball and verifies runtime script closure and local import resolution", () => {
    const packTempDir = mkdtempSync(join(tmpdir(), "fd-pack-test-"))
    try {
      const packOutput = execSync("npm pack --json", { cwd: process.cwd(), encoding: "utf-8" })
      const packInfo = JSON.parse(packOutput)
      const filename = packInfo[0].filename
      const tarballPath = join(process.cwd(), filename)
      expect(existsSync(tarballPath)).toBe(true)

      // Extract tarball
      execSync(`tar -xzf "${tarballPath}" -C "${packTempDir}"`, { stdio: "pipe" })
      const extractedPackageDir = join(packTempDir, "package")

      // Verify release-channel.mjs and release-alignment.mjs exist in extracted tarball
      expect(existsSync(join(extractedPackageDir, "scripts/release-alignment.mjs"))).toBe(true)
      expect(existsSync(join(extractedPackageDir, "scripts/release-channel.mjs"))).toBe(true)
      expect(existsSync(join(extractedPackageDir, "scripts/doctor-engine.mjs"))).toBe(true)
      expect(existsSync(join(extractedPackageDir, "scripts/config-mutator.mjs"))).toBe(true)
      expect(existsSync(join(extractedPackageDir, "scripts/clean-install-engine.mjs"))).toBe(true)

      // Test that release-channel can be imported/run with node without missing module errors
      const testImportScript = `
        import { resolveReleaseChannel } from './scripts/release-channel.mjs';
        if (typeof resolveReleaseChannel !== 'function') throw new Error('resolveReleaseChannel not exported');
        console.log('IMPORT_OK');
      `
      const out = execFileSync("node", ["--input-type=module", "-e", testImportScript], {
        cwd: extractedPackageDir,
        encoding: "utf-8",
      })
      expect(out).toContain("IMPORT_OK")

      // Clean up packed tarball
      try { rmSync(tarballPath, { force: true }) } catch {}
    } finally {
      try { rmSync(packTempDir, { recursive: true, force: true }) } catch {}
    }
  }, 30000)
})
