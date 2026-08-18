import { describe, it, expect } from "bun:test"
import {
  classifyMutation,
  isConfirmedSourceMutation,
  classifyShellMutation,
  MUTATING_TOOL_NAMES,
  READ_ONLY_TOOL_NAMES,
} from "../src/services/semantic-mutation"

describe("SEMANTIC MUTATION CLASSIFIER", () => {
  it("read-only tools that carry a file arg are NOT source mutations", () => {
    // fdx-read / read / grep with file args must be read_only regardless of the file.
    expect(classifyMutation("fdx-read", { file: "src/index.ts" })).toBe("read_only")
    expect(isConfirmedSourceMutation("fdx-read", { file: "src/index.ts" })).toBe(false)
    expect(classifyMutation("read", { file: "src/index.ts" })).toBe("read_only")
    expect(classifyMutation("read_file", { file: "src/index.ts" })).toBe("read_only")
    expect(classifyMutation("grep", { file: "src/index.ts", pattern: "x" })).toBe("read_only")
    expect(classifyMutation("glob", { file: "src/**/*.ts" })).toBe("read_only")
    expect(classifyMutation("search", { file: "src" })).toBe("read_only")
    expect(classifyMutation("fdx-search", { file: "src" })).toBe("read_only")
    expect(classifyMutation("fdx-grep", { file: "src" })).toBe("read_only")
    expect(classifyMutation("fdx-outline", { file: "src/index.ts" })).toBe("read_only")
    expect(classifyMutation("fdx-ls", { file: "src" })).toBe("read_only")
    expect(classifyMutation("fdx-diff", { file: "src" })).toBe("read_only")
    expect(classifyMutation("fdx-git", { file: "src" })).toBe("read_only")
    expect(classifyMutation("fdx-impact", { file: "src" })).toBe("read_only")
    expect(classifyMutation("fdx-batch", { file: "src" })).toBe("read_only")
  })

  it("mutating tools are confirmed source mutations", () => {
    for (const tool of ["write", "write_file", "edit", "edit_file", "patch", "apply_patch", "str_replace", "hash-edit", "create_file"]) {
      expect(classifyMutation(tool, { file: "src/x.ts", content: "..." })).toBe("mutating")
      expect(isConfirmedSourceMutation(tool, { file: "src/x.ts", content: "..." })).toBe(true)
    }
  })

  it("exported name sets cover the canonical tool lists", () => {
    expect(MUTATING_TOOL_NAMES.has("write")).toBe(true)
    expect(MUTATING_TOOL_NAMES.has("edit")).toBe(true)
    expect(READ_ONLY_TOOL_NAMES.has("fdx-read")).toBe(true)
    expect(READ_ONLY_TOOL_NAMES.has("grep")).toBe(true)
    // No overlap: a tool cannot be both mutating and read-only.
    for (const t of MUTATING_TOOL_NAMES) {
      expect(READ_ONLY_TOOL_NAMES.has(t)).toBe(false)
    }
  })

  it("bash commands are classified by head: rm mutates, cat does not, git status does not", () => {
    expect(classifyShellMutation("rm -rf build")).toBe("mutating")
    expect(classifyMutation("bash", { command: "rm -rf build" })).toBe("mutating")
    expect(isConfirmedSourceMutation("bash", { command: "rm -rf x" })).toBe(true)

    expect(classifyShellMutation("cat src/index.ts")).toBe("read_only")
    expect(classifyMutation("bash", { command: "cat src/index.ts" })).toBe("read_only")

    expect(classifyShellMutation("git status")).toBe("read_only")
    expect(classifyMutation("bash", { command: "git status" })).toBe("read_only")
    expect(classifyMutation("bash", { command: "git diff HEAD~1" })).toBe("read_only")
    expect(classifyMutation("bash", { command: "git log --oneline" })).toBe("read_only")
  })

  it("git write subcommands + write-redirects are mutating", () => {
    expect(classifyMutation("bash", { command: "git init" })).toBe("mutating")
    expect(classifyMutation("bash", { command: "echo hi > file.txt" })).toBe("mutating")
  })

  it("ambiguous pipelines that contain a mutation demote to mutating", () => {
    // tee in a pipeline is a write (copies to a file) → whole pipeline mutates.
    expect(classifyShellMutation("cat a.txt | tee out.txt")).toBe("mutating")
    expect(classifyMutation("bash", { command: "cat a.txt | tee out.txt" })).toBe("mutating")
  })
})