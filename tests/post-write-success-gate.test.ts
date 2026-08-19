import { describe, it, expect } from "bun:test"
import { isConfirmedSourceMutation } from "../src/services/semantic-mutation"

describe("Authoritative Post-Write Success Gate Regressions", () => {
  it("classifies write and edit tools as source mutations only with valid file arguments", () => {
    expect(isConfirmedSourceMutation("write_file", { filePath: "src/main.ts" })).toBe(true)
    expect(isConfirmedSourceMutation("edit", { file: "src/main.ts" })).toBe(true)
    expect(isConfirmedSourceMutation("patch", { path: "src/main.ts" })).toBe(true)
    expect(isConfirmedSourceMutation("str_replace", { file_path: "src/main.ts" })).toBe(true)
  })

  it("does not classify read-only inspection as source mutation", () => {
    expect(isConfirmedSourceMutation("read", { file: "src/main.ts" })).toBe(false)
    expect(isConfirmedSourceMutation("read_file", { path: "src/main.ts" })).toBe(false)
    expect(isConfirmedSourceMutation("fdx-read", { file: "src/main.ts" })).toBe(false)
    expect(isConfirmedSourceMutation("bash", { command: "git status" })).toBe(false)
  })
})
