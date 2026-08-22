import { describe, it, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("P2 Security: Installer argument safety & adversarial profile validation", () => {
  const installScript = join(process.cwd(), "install.sh")

  it("passes valid profile in doctor mode", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "installer-home-"))
    try {
      const res = spawnSync("bash", [installScript, "--doctor", "--profile", "minimal"], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: tmpHome },
        encoding: "utf-8",
      })
      expect(res.status).toBe(0)
      expect(res.stdout).toContain("minimal")
    } finally {
      try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
    }
  })

  it("rejects unsupported profiles safely without executing commands", () => {
    const tmpHome = mkdtempSync(join(tmpdir(), "installer-home-"))
    const markerFile = join(tmpHome, "injected_pwned.txt")

    const adversarialProfiles = [
      "invalid-profile",
      "; touch " + markerFile,
      "$(touch " + markerFile + ")",
      "`touch " + markerFile + "`",
      "$EVIL",
      "minimal; rm -rf /",
      "--leading-flag",
      "profile with spaces",
      "'single-quoted'",
      "\"double-quoted\"",
    ]

    try {
      for (const profile of adversarialProfiles) {
        const res = spawnSync("bash", [installScript, "--doctor", "--profile", profile], {
          cwd: process.cwd(),
          env: { ...process.env, HOME: tmpHome },
          encoding: "utf-8",
        })
        expect(res.status).toBe(1)
        expect(res.stderr).toContain("Invalid profile")
        // Assert no command was executed via shell expansion
        expect(existsSync(markerFile)).toBe(false)
      }
    } finally {
      try { rmSync(tmpHome, { recursive: true, force: true }) } catch {}
    }
  })
})
