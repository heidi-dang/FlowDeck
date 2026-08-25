import { describe, expect, it } from "bun:test"
import { resolveRustToolchain } from "../scripts/rust-toolchain.mjs"

type Invocation = { executable: string; args: string[] }

function fakeToolchain(invocations: Invocation[]) {
  return (executable: string, args: string[]) => {
    invocations.push({ executable, args })
    if (executable === "/fixture/rustup" && args.join(" ") === "which cargo") return "/fixture/bin/cargo"
    if (executable === "/fixture/rustup" && args.join(" ") === "which rustc") return "/fixture/bin/rustc"
    if (executable === "/fixture/bin/cargo" && args.join(" ") === "--version") return "cargo 1.98.0"
    if (executable === "/fixture/bin/rustc" && args.join(" ") === "--version") return "rustc 1.98.0"
    throw new Error(`unexpected command: ${executable} ${args.join(" ")}`)
  }
}

describe("resolveRustToolchain", () => {
  it("prefers Rustup over an incompatible PATH cargo", () => {
    const invocations: Invocation[] = []
    const toolchain = resolveRustToolchain({
      env: { PATH: "/old/bin", RUSTUP: "/fixture/rustup" },
      execFile: fakeToolchain(invocations),
      exists: () => true,
    })

    expect(toolchain.cargo).toBe("/fixture/bin/cargo")
    expect(toolchain.rustc).toBe("/fixture/bin/rustc")
    expect(toolchain.env.PATH.startsWith("/fixture/bin")).toBe(true)
    expect(invocations.some((call) => call.executable === "/old/bin/cargo")).toBe(false)
  })

  it("honors explicit CARGO and RUSTC overrides", () => {
    const invocations: Invocation[] = []
    const toolchain = resolveRustToolchain({
      env: { PATH: "/old/bin", CARGO: "/explicit/cargo", RUSTC: "/explicit/rustc" },
      execFile: (executable: string, args: string[]) => {
        invocations.push({ executable, args })
        if (executable === "/explicit/cargo") return "cargo 1.98.0"
        if (executable === "/explicit/rustc") return "rustc 1.98.0"
        throw new Error("unexpected command")
      },
    })

    expect(toolchain.cargo).toBe("/explicit/cargo")
    expect(toolchain.rustc).toBe("/explicit/rustc")
    expect(invocations).toHaveLength(2)
  })

  it("fails closed when Cargo and Rustc versions do not match", () => {
    expect(() => resolveRustToolchain({
      env: { PATH: "", CARGO: "/explicit/cargo", RUSTC: "/explicit/rustc" },
      execFile: (executable: string) => executable.endsWith("cargo") ? "cargo 1.98.0" : "rustc 1.75.0",
    })).toThrow(/Rust toolchain mismatch/)
  })
})
