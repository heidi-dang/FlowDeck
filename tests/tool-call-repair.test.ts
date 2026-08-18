import { describe, it, expect } from "bun:test"
import {
  repairToolCall,
  validateRequiredFields,
} from "../src/services/tool-call-repair"

describe("ToolCallRepairService — Milestone H", () => {
  // Required: deterministic tool repair applies
  it("normalizes path alias to file_path for fdx-read", () => {
    const result = repairToolCall("fdx-read", { path: "src/index.ts" })
    expect(result.repaired).toBe(true)
    expect(result.args["file_path"]).toBe("src/index.ts")
    expect("path" in result.args).toBe(false)
    expect(result.repairs).toContain("alias: path -> file_path")
  })

  it("normalizes filename alias to file_path", () => {
    const result = repairToolCall("fdx-read", { filename: "src/auth.ts" })
    expect(result.repaired).toBe(true)
    expect(result.args["file_path"]).toBe("src/auth.ts")
  })

  it("normalizes cmd to command for bash tool", () => {
    const result = repairToolCall("bash", { cmd: "npm test" })
    expect(result.repaired).toBe(true)
    expect(result.args["command"]).toBe("npm test")
    expect("cmd" in result.args).toBe(false)
  })

  it("normalizes subagent to subagent_type", () => {
    const result = repairToolCall("task", { subagent: "debugger" })
    expect(result.repaired).toBe(true)
    expect(result.args["subagent_type"]).toBe("debugger")
  })

  it("normalizes scalar files to array", () => {
    const result = repairToolCall("fdx-batch", { files: "src/index.ts" })
    expect(result.repaired).toBe(true)
    expect(Array.isArray(result.args["files"])).toBe(true)
    expect(result.args["files"]).toEqual(["src/index.ts"])
  })

  it("normalizes scalar paths to array", () => {
    const result = repairToolCall("fdx-read", { paths: "src/a.ts" })
    expect(result.repaired).toBe(true)
    expect(Array.isArray(result.args["paths"])).toBe(true)
  })

  it("normalizes Windows path separators in file_path", () => {
    const result = repairToolCall("fdx-read", { file_path: "src\\auth\\index.ts" })
    expect(result.repaired).toBe(true)
    expect(result.args["file_path"]).toBe("src/auth/index.ts")
  })

  // Required: ambiguous tool call NOT repaired (no semantic guessing)
  it("does NOT modify unrecognized argument names", () => {
    const result = repairToolCall("fdx-read", { totally_unknown_field: "value" })
    expect(result.repaired).toBe(false)
    expect(result.args["totally_unknown_field"]).toBe("value")
  })

  it("does NOT repair when canonical field already present", () => {
    const result = repairToolCall("fdx-read", {
      file_path: "canonical.ts",
      path: "alias.ts",
    })
    // canonical already exists — alias should not clobber it
    expect(result.args["file_path"]).toBe("canonical.ts")
  })

  it("returns repaired=false and empty repairs when no changes needed", () => {
    const result = repairToolCall("fdx-read", { file_path: "src/index.ts" })
    expect(result.repaired).toBe(false)
    expect(result.repairs).toHaveLength(0)
    expect(result.args["file_path"]).toBe("src/index.ts")
  })

  it("does not modify original args object (immutable input)", () => {
    const original = { path: "src/index.ts", other: 42 }
    repairToolCall("fdx-read", original)
    expect("path" in original).toBe(true)
    expect(original.path).toBe("src/index.ts")
  })

  // validateRequiredFields
  it("validateRequiredFields returns null when all fields present", () => {
    const err = validateRequiredFields("fdx-read", { file_path: "src/a.ts" }, ["file_path"])
    expect(err).toBeNull()
  })

  it("validateRequiredFields returns error string for missing fields", () => {
    const err = validateRequiredFields("fdx-read", {}, ["file_path"])
    expect(err).not.toBeNull()
    expect(err).toContain("TOOL_MISSING_REQUIRED_FIELDS")
    expect(err).toContain("file_path")
  })

  it("validateRequiredFields identifies all missing fields", () => {
    const err = validateRequiredFields("task", {}, ["prompt", "subagent_type"])
    expect(err).toContain("prompt")
    expect(err).toContain("subagent_type")
  })
})
