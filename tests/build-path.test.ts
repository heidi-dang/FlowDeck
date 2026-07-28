/**
 * Build path tests
 *
 * Verifies the build entrypoint's WSL UNC path detection and parsing.
 * Actual build execution is tested by running `npm run build` separately.
 */

import { describe, it, expect } from "vitest"

describe("WSL UNC path detection", () => {
  it("detects \\\\wsl.localhost\\ path", async () => {
    const mod = await import("../scripts/build-entry.mjs")
    expect(mod.isWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\project")).toBe(true)
    const parsed = mod.parseWslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\project")
    expect(parsed).toEqual({ distro: "Ubuntu", linuxPath: "/home/project" })
  })

  it("detects \\\\wsl$\\ path", async () => {
    const mod = await import("../scripts/build-entry.mjs")
    expect(mod.isWslUncPath("\\\\wsl$\\Ubuntu\\home\\project")).toBe(true)
  })

  it("parses deep WSL UNC path", async () => {
    const mod = await import("../scripts/build-entry.mjs")
    const parsed = mod.parseWslUncPath("\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\my-project\\src")
    expect(parsed).toEqual({ distro: "Ubuntu-24.04", linuxPath: "/home/user/my-project/src" })
  })

  it("rejects non-UNC paths", async () => {
    const mod = await import("../scripts/build-entry.mjs")
    expect(mod.isWslUncPath("/home/user/project")).toBe(false)
    expect(mod.isWslUncPath("C:\\Users\\user")).toBe(false)
    expect(mod.isWslUncPath("")).toBe(false)
  })

  it("rejects malformed UNC paths", async () => {
    const mod = await import("../scripts/build-entry.mjs")
    expect(mod.parseWslUncPath("/home/user")).toBeNull()
    expect(mod.parseWslUncPath("\\\\wsl.localhost\\")).toBeNull()
  })
})
