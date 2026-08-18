/**
 * Semantic Mutation Classifier (Requirement: read-only tools must NOT count as
 * source mutation).
 *
 * The runtime's convergence / progress tracking previously treated "having a
 * `file` argument" as proof of a source mutation. That is wrong: read-only
 * tools (fdx-read, grep, glob, search, ...) also carry file arguments but do
 * not change source. This module is the canonical classifier the after-tool
 * block in `index.ts` consumes so that only real, mutating operations advance
 * convergence.
 *
 * Classification is purely tool + args — never the tool's output/error state.
 * The caller in `index.ts` decides independently how to treat "errored" tool
 * calls; this module answers only "did this tool+args mutate source?".
 */

import { classifyShellCommand, tokenize } from "./shell-command-classifier"

export type MutationClass = "mutating" | "read_only" | "ambiguous"

/** Tools that always mutate source regardless of their arguments. */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write",
  "write_file",
  "edit",
  "edit_file",
  "patch",
  "apply_patch",
  "str_replace",
  "hash-edit",
  "create_file",
])

/**
 * Tools that merely carry a `file` argument but never mutate source. These
 * must be read_only regardless of the file arg (they inspect, search, diff,
 * list, or batch-overlay content).
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "fdx-read",
  "read",
  "grep",
  "glob",
  "search",
  "fdx-search",
  "fdx-grep",
  "fdx-outline",
  "fdx-ls",
  "fdx-diff",
  "fdx-git",
  "fdx-impact",
  "fdx-batch",
])

/** Shell commands whose head is always mutating. */
const MUTATING_SHELL_HEADS: ReadonlySet<string> = new Set([
  "rm",
  "mv",
  "cp",
  "mkdir",
  "rmdir",
  "touch",
  "tee",
  "ln",
  "chmod",
  "chown",
  "chgrp",
  "source",
  "install",
  "truncate",
  "shred",
  "unlink",
])

/** Shell commands whose head is always read-only inspection. */
const READ_ONLY_SHELL_HEADS: ReadonlySet<string> = new Set([
  "cat",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ls",
  "head",
  "tail",
  "wc",
  "find",
  "sed",
  "less",
  "more",
  "pwd",
  "echo",
  "printf",
  "diff",
  "sort",
  "uniq",
  "cut",
  "tr",
  "awk",
  "stat",
  "du",
  "df",
  "file",
  "tree",
  "which",
  "type",
  "man",
  "realpath",
  "readlink",
  "dirname",
  "basename",
  "git",
])

/** `sed -n ...` is a read-only print; any other sed use is treated ambiguous. */
function isSedReadOnly(args: Record<string, unknown>): boolean {
  const cmd = String(args?.command ?? args?.cmd ?? args?.bash ?? "").trim()
  const tokens = tokenize(cmd)
  return tokens.some((t) => t === "-n")
}

/** Detect a write-redirect operator (`>`, `>>`, `1>` etc., e.g. `echo x > file`). */
function hasWriteRedirect(command: string): boolean {
  return /[0-9]?>>?\s*(?!\(|\|)/.test(command)
}

/**
 * Classify a bash/shell command string by its command head and structure.
 * Pipelines/redirections that contain a mutating segment demote an otherwise
 * read-only (or unknown) command to mutating; a plain read-only head that
 * carries no mutation stays read_only.
 */
export function classifyShellMutation(command: string): MutationClass {
  const trimmed = (command ?? "").trim()
  if (trimmed.length === 0) {
    return "ambiguous"
  }

  const tokens = tokenize(trimmed)
  if (tokens.length === 0) {
    return "ambiguous"
  }
  const head = tokens[0].toLowerCase()

  // Decompose into segments on pipelines / control operators. Any segment
  // that mutates demotes the whole pipeline to mutating.
  const segments = trimmed.split(/[|;&]+/).map((s) => s.trim()).filter(Boolean)
  let sawUnknown: boolean = false
  for (const seg of segments) {
    const segTokens = tokenize(seg)
    if (segTokens.length === 0) continue
    const segHead = segTokens[0].toLowerCase()
    if (MUTATING_SHELL_HEADS.has(segHead)) return "mutating"
    if (segHead === "git") {
      // Reuse the full git classifier: status/diff/log/show are read-only.
      const cls = classifyShellCommand(seg)
      if (cls.category !== "read") return "mutating"
      continue
    }
    if (segHead === "sed") {
      if (!isSedReadOnly({ command: seg })) {
        sawUnknown = true
      }
      continue
    }
    if (hasWriteRedirect(seg)) return "mutating"
  }

  // A single-segment command classified by its head.
  if (MUTATING_SHELL_HEADS.has(head)) return "mutating"
  if (head === "git") {
    const cls = classifyShellCommand(trimmed)
    return cls.category === "read" ? "read_only" : "mutating"
  }
  if (READ_ONLY_SHELL_HEADS.has(head)) {
    if (head === "sed" && !isSedReadOnly({ command: trimmed })) return "ambiguous"
    return "read_only"
  }
  if (hasWriteRedirect(trimmed)) return "mutating"
  if (sawUnknown) return "ambiguous"
  return "ambiguous"
}

/**
 * Classify a tool name + args into a mutation class.
 *
 * Mutating tools are always "mutating". Every non-mutating tool that merely
 * carries a `file` argument — including every read/glob/grep/search/fdx-*
 * tool — is "read_only". Bash/shell commands are classified structurally by
 * their command head and redirects.
 */
export function classifyMutation(toolLower: string, args: Record<string, unknown>): MutationClass {
  const tool = String(toolLower ?? "").toLowerCase().trim()

  if (MUTATING_TOOL_NAMES.has(tool)) {
    return "mutating"
  }
  if (READ_ONLY_TOOL_NAMES.has(tool)) {
    return "read_only"
  }
  if (tool === "bash" || tool === "shell" || tool === "run_in_terminal") {
    const command =
      String(args?.command ?? args?.cmd ?? args?.bash ?? args?.exec ?? "") || ""
    return classifyShellMutation(command)
  }
  // Any remaining tool (fdx-* not enumerated, codegraph, etc.) with a file
  // arg is still read_only unless it is a known mutating tool — we never guess
  // "mutation" merely from the presence of a file argument.
  return "read_only"
}

/**
 * True ONLY for a confirmed mutating classification. This is what the
 * after-tool block in `index.ts` uses to decide whether the call advanced
 * source convergence. "ambiguous" and "read_only" both return false — a
 * non-confirmed mutation must NOT reset convergence.
 */
export function isConfirmedSourceMutation(toolLower: string, args: Record<string, unknown>): boolean {
  return classifyMutation(toolLower, args) === "mutating"
}
