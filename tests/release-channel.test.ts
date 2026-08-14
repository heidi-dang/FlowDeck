import { describe, it, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolveReleaseChannel } from "../scripts/release-channel.mjs"

describe("resolveReleaseChannel", () => {
  const cases = [
    ["2.0.0-alpha.1", "alpha"], ["2.0.0-alpha.2", "alpha"], ["2.0.0-alpha.3", "alpha"], ["2.0.0-alpha.4", "alpha"], ["2.0.0-alpha.99", "alpha"],
    ["2.0.0-beta.1", "beta"], ["2.0.0-beta.10", "beta"],
    ["2.0.0-rc.1", "next"], ["2.0.0-rc.10", "next"],
    ["2.0.0", "latest"], ["2.1.0", "latest"], ["3.0.0", "latest"],
  ] as const

  for (const [version, channel] of cases) {
    it(`${version} resolves to ${channel}`, () => expect(resolveReleaseChannel(version)).toBe(channel))
  }

  for (const version of ["2.0.0-preview.1", "2.0.0-dev.1", "2.0.0-nightly.1", "2.0.0-canary.1", "garbage", "v2.0.0-alpha.1", "2", "2.0", "2.0.0-alpha.foo", "2.0.0-alpha.", "2.0.0-"]) {
    it(`rejects ${version}`, () => expect(() => resolveReleaseChannel(version)).toThrow())
  }

  it("CLI output is exact and invalid versions exit non-zero", () => {
    const good = spawnSync(process.execPath, ["scripts/release-channel.mjs", "2.0.0-rc.1"], { encoding: "utf8" })
    expect(good.status).toBe(0)
    expect(good.stdout).toBe("next\n")
    const bad = spawnSync(process.execPath, ["scripts/release-channel.mjs", "2.0.0-preview.1"], { encoding: "utf8" })
    expect(bad.status).not.toBe(0)
    expect(bad.stdout).toBe("")
  })
})
