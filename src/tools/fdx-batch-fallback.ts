/**
 * fdx-batch-fallback.ts — pure-TypeScript batch executor + capability metadata
 * mirror (Dev 3 Task 4, Phase 7: native/JS fallback parity).
 *
 * Mirrors crates/fdx/src/batch/mod.rs (executor + wire shapes) and
 * crates/fdx/src/batch/registry.rs (descriptor registry) so that when neither
 * the daemon nor the one-shot native `fdx batch-query` binary is available,
 * the client can still serve the typed batch surface with wire-compatible
 * `BatchResponse` JSON: the same envelope, per-op result shapes, error
 * codes/messages, and output-bounding/truncation semantics.
 *
 * Fidelity notes:
 * - EXACT parity: whole-batch preflight (ANY invalid op — unknown, mutating,
 *   non-batchable — rejects the ENTIRE batch with E_BAD_REQUEST before any
 *   operation executes), repository-state probing (HEAD SHA / dirty
 *   fingerprint / config fingerprint captured at batch start and revalidated
 *   before each op; drift aborts remaining ops with E_STALE_SNAPSHOT and
 *   reports `staleSnapshot: true`), raw reads (TextResult), grep, error
 *   codes/messages, and the response envelope (version / failedFast /
 *   staleSnapshot, input-order responses, truncation markers).
 * - SHAPE parity: code-mode reads (CodeResult), search, outline, impact, whose
 *   symbols come from tree-sitter in the native binary. The TS fallback uses
 *   regex declaration scanning (DECL_PATTERNS), so AST-derived fields
 *   (signature, line_end, doc_comment, body) are best-effort; the wire shape
 *   and key sets match.
 * - testsFor: the fallback has no index snapshot, so it always returns the
 *   same E_INTERNAL the native executor returns when no snapshot exists.
 */

import { spawnSync } from "node:child_process"
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import type {
  BatchOperation,
  BatchResponse,
  CapabilitiesPayload,
  OperationParams,
  OperationResponse,
  ToolDescriptor,
} from "./fdx-daemon-client"

// ─── Constants (mirror crates/fdx/src/batch/mod.rs) ────────────────────────

/** Max operations per batch (whole-batch rejection). */
export const TS_MAX_BATCH_OPS = 64

/** Cumulative serialized result budget for the whole batch. */
export const TS_MAX_BATCH_OUTPUT_BYTES = 40 * 1024

/** Error codes (mirror batch::err). */
export const E_BAD_REQUEST = "E_BAD_REQUEST"
export const E_UNSUPPORTED = "E_UNSUPPORTED"
export const E_INTERNAL = "E_INTERNAL"
/** An operation that never started because an earlier op failed with
 * `failFast` set. The operation was NOT executed; the response exists only to
 * preserve the one-response-per-input-operation cardinality. */
export const E_CANCELLED = "E_CANCELLED"
/** An operation that never started because the repository state drifted
 * mid-batch (HEAD / dirty tree / config changed since capture). The operation
 * was NOT executed; the batch is flagged `staleSnapshot` so clients never
 * persist results spanning two repository states. Distinct from
 * `E_CANCELLED`: the batch was invalidated by an external mutation, not
 * stopped by the client. */
export const E_STALE_SNAPSHOT = "E_STALE_SNAPSHOT"

const KIB = 1024

/** Absolute cap on grep context lines (mirror reader::grep::ABSOLUTE_MAX_CONTEXT). */
const ABSOLUTE_MAX_CONTEXT = 3

/** Absolute cap on grep matches (mirror reader::grep::ABSOLUTE_MAX_MATCHES). */
const ABSOLUTE_MAX_MATCHES = 200

/** Directories never walked (mirrors fdx-shared native fallbacks). */
const ALWAYS_EXCLUDED = ["node_modules", ".git", "dist", "target", ".next", ".cache"]

/** Whole-batch structural rejection (empty / over-capacity / duplicate ids /
 * any invalid operation). */
export class BatchRejectError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = "BatchRejectError"
    this.code = code
  }
}

// ─── Repository-state probe (mirror batch::RepoStateProbe) ─────────────────

/**
 * Repository-state revalidation contract (mirror batch::BatchStateProbe).
 *
 * The batch captures the repository identity fields (HEAD SHA, dirty
 * working-tree fingerprint, configuration fingerprint) at batch start and
 * revalidates them before each operation. If ANY captured field changed, the
 * batch aborts all remaining operations with `E_STALE_SNAPSHOT` (never
 * executed) and reports `staleSnapshot: true`, so clients never persist
 * results that span two repository states.
 */
export interface BatchStateProbe {
  /** True while the captured repository state still matches the worktree. */
  stateUnchanged(): boolean
}

/** Run git and return trimmed stdout on success, or null on failure. */
function gitOut(args: string[], cwd: string): string | null {
  try {
    const res = spawnSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: 15_000,
      shell: false,
      maxBuffer: 10 * 1024 * 1024,
    })
    if (res.status === 0) return (res.stdout ?? "").trimEnd()
    return null
  } catch {
    return null
  }
}

/** Current HEAD SHA (`git rev-parse HEAD`). Empty when not a git repo. */
function gitHeadSha(cwd: string): string {
  return gitOut(["rev-parse", "HEAD"], cwd) ?? ""
}

/**
 * Dirty-tree fingerprint: a stable hash over `git status --porcelain=v1 -z`
 * AND the content hashes of files reported as modified/untracked. Two equal
 * trees produce the same fingerprint; ANY worktree change — including a
 * content edit inside an already-dirty file — flips it. Mirrors the semantics
 * (not the exact bytes) of batch::dirty_fingerprint.
 */
function dirtyFingerprint(cwd: string): string {
  const out = gitOut(["status", "--porcelain=v1", "-z", "--no-renames"], cwd)
  if (out === null || out.length === 0) {
    return sha256Hex(Buffer.from("dirty\0"))
  }
  const hasher = newCryptoHash()
  hasher.update(Buffer.from("dirty\0"))
  // NUL-delimited records: "<XY> <path>\0". Split, filter empty, sort by
  // path for determinism.
  const records = out.split("\0").filter((r) => r.length > 0).sort()
  let contentCount = 0
  const MAX_CONTENT_FILES = 1000
  for (const record of records) {
    if (record.length < 4) continue
    hasher.update(Buffer.from(record))
    hasher.update(Buffer.from("\0"))
    const statusPart = record.slice(0, 2)
    if (statusPart.startsWith("R")) {
      contentCount += 1
      continue
    }
    const path = record.slice(3).trim()
    if (!path) continue
    if (
      (statusPart.includes("M") || statusPart.includes("?") || statusPart.includes("A") || statusPart.startsWith("R")) &&
      contentCount < MAX_CONTENT_FILES
    ) {
      try {
        const full = join(cwd, path)
        const st = statSync(full)
        if (st.isFile()) {
          hasher.update(readFileSync(full))
          hasher.update(Buffer.from("\0"))
          contentCount += 1
        }
      } catch { /* unreadable/missing file contributes nothing */ }
    }
  }
  return hasher.digest("hex")
}

/** Hash of the FlowDeck/FDX config files found in the worktree root. */
function configHash(cwd: string): string {
  const hasher = newCryptoHash()
  for (const name of [".flowdeck.json", ".flowdeck.jsonc", ".fdx.json", ".fdxrc", "flowdeck.json"]) {
    try {
      hasher.update(Buffer.from(name))
      hasher.update(readFileSync(join(cwd, name)))
    } catch { /* missing file contributes nothing */ }
  }
  return hasher.digest("hex").slice(0, 16)
}

/** Hash of the ignore rules (.gitignore / .ignore / .fdignore) at the root. */
function ignoreHash(cwd: string): string {
  const hasher = newCryptoHash()
  for (const name of [".gitignore", ".ignore", ".fdignore"]) {
    try {
      hasher.update(Buffer.from(name))
      hasher.update(readFileSync(join(cwd, name)))
    } catch { /* missing file contributes nothing */ }
  }
  return hasher.digest("hex").slice(0, 16)
}

/** Configuration fingerprint = hash(config_hash + ignore_hash). */
function configurationFingerprint(cwd: string): string {
  const hasher = newCryptoHash()
  hasher.update(Buffer.from(configHash(cwd)))
  hasher.update(Buffer.from(ignoreHash(cwd)))
  return hasher.digest("hex")
}

function newCryptoHash(): import("node:crypto").Hash {
  const crypto = require("node:crypto") as typeof import("node:crypto")
  return crypto.createHash("sha256")
}

/**
 * Production state probe: captures HEAD SHA, dirty fingerprint and
 * configuration fingerprint and recomputes each on `stateUnchanged()`.
 * Returns `null` when the cwd is not inside a git repository — the same
 * condition under which the native executor's cache context (and probe) is
 * inactive, so `staleSnapshot` stays false outside git (mirrors
 * `QueryCacheContext::resolve`).
 */
export function createRepoStateProbe(cwd?: string): BatchStateProbe | null {
  if (!cwd) return null
  const root = resolve(cwd)
  const repositorySha = gitHeadSha(root)
  if (!repositorySha) return null // not a git worktree
  const capturedDirty = dirtyFingerprint(root)
  const capturedConfig = configurationFingerprint(root)
  return {
    stateUnchanged(): boolean {
      if (gitHeadSha(root) !== repositorySha) return false
      if (dirtyFingerprint(root) !== capturedDirty) return false
      if (configurationFingerprint(root) !== capturedConfig) return false
      return true
    },
  }
}

// ─── Capability metadata mirror (registry.rs) ──────────────────────────────

function descriptor(name: string, overrides: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name,
    readOnly: true,
    supportsStreaming: false,
    supportsCancellation: false,
    supportsBatching: true,
    cachePolicy: "repository",
    expectedLatencyClass: "fast",
    maximumOutputBytes: 256 * KIB,
    negativeCacheEligible: false,
    ...overrides,
  }
}

/**
 * The canonical descriptor registry, mirrored field-for-field from
 * crates/fdx/src/batch/registry.rs (same order: batch ops, hosted commands,
 * then the capabilities query itself).
 */
export function tsToolDescriptors(): ToolDescriptor[] {
  const out: ToolDescriptor[] = []

  // ── Batch read-only operations ────────────────────────────────────────────
  out.push(descriptor("read", { expectedLatencyClass: "instant" }))

  out.push(
    descriptor("grep", { expectedLatencyClass: "fast", negativeCacheEligible: true }),
  )
  out.push(
    descriptor("search", { expectedLatencyClass: "fast", negativeCacheEligible: true }),
  )
  out.push(descriptor("outline", { expectedLatencyClass: "fast" }))
  out.push(descriptor("impact", { expectedLatencyClass: "slow" }))
  out.push(
    descriptor("testsFor", {
      expectedLatencyClass: "fast",
      maximumOutputBytes: 128 * KIB,
      negativeCacheEligible: true,
    }),
  )

  // ── Hosted commands (negotiated in `hello` capabilities) ─────────────────
  out.push(descriptor("version", { expectedLatencyClass: "instant", maximumOutputBytes: 8 * KIB }))
  out.push(descriptor("ls", { expectedLatencyClass: "fast", maximumOutputBytes: 128 * KIB }))

  for (const name of [
    "files.query",
    "symbols.query",
    "dependencies.query",
    "testsFor.query",
    "gitState.query",
  ]) {
    out.push(
      descriptor(name, { maximumOutputBytes: 128 * KIB, negativeCacheEligible: true }),
    )
  }

  out.push(descriptor("index.status", { maximumOutputBytes: 8 * KIB }))

  for (const name of ["index.refresh", "index.rebuild", "index.invalidate"]) {
    out.push(
      descriptor(name, {
        readOnly: false,
        supportsBatching: false,
        cachePolicy: "none",
        expectedLatencyClass: "slow",
        maximumOutputBytes: 8 * KIB,
      }),
    )
  }

  // ── The capabilities query itself ────────────────────────────────────────
  out.push(
    descriptor("capabilities.query", {
      expectedLatencyClass: "instant",
      maximumOutputBytes: 128 * KIB,
      supportsBatching: false,
    }),
  )

  return out
}

/** Serialize the full registry (used by `capabilities.query` fallback). */
export function tsCapabilitiesPayload(): CapabilitiesPayload {
  return { descriptors: tsToolDescriptors() }
}

function tsToolDescriptor(name: string): ToolDescriptor | undefined {
  return tsToolDescriptors().find((d) => d.name === name)
}

// ─── Language detection (mirror reader/code/languages/mod.rs) ──────────────

const LANGUAGE_BY_EXT: Record<string, string> = {
  rs: "rust",
  py: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  java: "java",
}

function detectLanguage(path: string): string | null {
  const dot = path.lastIndexOf(".")
  if (dot < 0 || dot === path.length - 1) return null
  return LANGUAGE_BY_EXT[path.slice(dot + 1)] ?? null
}

function isCodeFile(path: string): boolean {
  return detectLanguage(path) !== null
}

// ─── File walking (mirror collect_text_files / collect_code_files) ────────

/** Recursively collect files under `paths`, skipping excluded dirs and binary
 * text candidates (null byte in the first 8KB, mirroring grep's is_text_file). */
function collectFiles(paths: string[], mode: "text" | "code"): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  const visit = (p: string) => {
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      let entries: string[]
      try {
        entries = readdirSync(p)
      } catch {
        return
      }
      entries.sort()
      for (const name of entries) {
        if (ALWAYS_EXCLUDED.includes(name)) continue
        visit(join(p, name))
      }
    } else if (st.isFile()) {
      if (mode === "code" && !isCodeFile(p)) return
      if (mode === "text" && !isTextCandidate(p)) return
      const key = resolve(p)
      if (seen.has(key)) return
      seen.add(key)
      out.push(p)
    }
  }

  for (const path of paths) visit(path)
  return out
}

/** Binary check: null byte in the first 8KB (mirror grep::is_text_file). */
function isTextCandidate(path: string): boolean {
  try {
    const fd = readFileSync(path)
    const n = Math.min(fd.length, 8192)
    for (let i = 0; i < n; i++) {
      if (fd[i] === 0) return false
    }
    return true
  } catch {
    return false
  }
}

/** Split source into lines exactly like Rust `str::lines()`: splits on \n
 * (and \r\n) and emits no trailing empty segment when the string ends with a
 * newline. Native line counts and grep context depend on this. */
function splitLines(source: string): string[] {
  const raw = source.split(/\r?\n/)
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop()
  return raw
}

// ─── Path helpers (mirror batch::resolve_path / resolve_paths) ─────────────

function resolvePath(p: string, cwd: string | undefined): string {
  if (p.startsWith("/")) return p
  return cwd ? join(cwd, p) : p
}

function resolvePaths(paths: string[] | undefined, cwd: string | undefined): string[] {
  if (!paths || paths.length === 0) return [cwd ?? "."]
  return paths.map((p) => resolvePath(p, cwd))
}

// ─── Regex declaration scan (symbol extraction for code-mode ops) ──────────

/** Regex patterns for common declarations (mirrors fdx-shared DECL_PATTERNS). */
const DECL_PATTERNS: Array<{ regex: RegExp; kind: string }> = [
  { regex: /^export\s+(async\s+)?function\s+(\w+)/gm, kind: "function" },
  { regex: /^(async\s+)?function\s+(\w+)/gm, kind: "function" },
  { regex: /^export\s+(default\s+)?(class|interface|type|enum|abstract\s+class)\s+(\w+)/gm, kind: "$2" },
  { regex: /^(class|interface|type|enum|abstract\s+class)\s+(\w+)/gm, kind: "$1" },
  { regex: /^export\s+const\s+(\w+)\s*[:=]/gm, kind: "const" },
  { regex: /^const\s+(\w+)\s*[:=].*=>/gm, kind: "arrow_function" },
  { regex: /^(fn|pub\s+fn)\s+(\w+)/gm, kind: "function" },
  { regex: /^(struct|trait|enum|impl)\s+(\w+)/gm, kind: "type" },
  { regex: /^def\s+(\w+)/gm, kind: "function" },
  { regex: /^class\s+(\w+)/gm, kind: "class" },
  { regex: /^func\s+(\w+)/gm, kind: "function" },
]

interface ScannedSymbol {
  kind: string
  name: string
  signature: string
  lineStart: number
  lineEnd: number
}

/** Best-effort brace balancing for a declaration's closing line. */
function findDeclEnd(lines: string[], startIdx: number): number {
  let depth = 0
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]
    for (const ch of line) {
      if (ch === "{") depth++
      else if (ch === "}") depth--
    }
    if (depth <= 0 && line.includes("}")) return i + 1
  }
  return lines.length
}

function scanSymbols(source: string): ScannedSymbol[] {
  const lines = splitLines(source)
  const symbols: ScannedSymbol[] = []
  for (const { regex, kind } of DECL_PATTERNS) {
    let m: RegExpExecArray | null
    while ((m = regex.exec(source)) !== null) {
      const lineIdx = source.slice(0, m.index).split("\n").length - 1
      const name = m[m.length - 1]
      const kindStr = kind.startsWith("$") ? m[parseInt(kind.slice(1), 10)] || kind : kind
      // Skip duplicates (first matching pattern wins for a given line+name).
      if (symbols.some((s) => s.name === name && s.lineStart === lineIdx + 1)) {
        if (m.index === regex.lastIndex) regex.lastIndex++
        continue
      }
      symbols.push({
        kind: kindStr,
        name,
        // Mirrors reader/code/prototype.rs extract_signature for single-line
        // declarations (multi-line signatures differ — shape parity only).
        signature: lines[lineIdx]?.trim().replace(/[{(]+$/, "").trim() ?? "",
        lineStart: lineIdx + 1,
        lineEnd: findDeclEnd(lines, lineIdx),
      })
      if (m.index === regex.lastIndex) regex.lastIndex++
    }
  }
  symbols.sort((a, b) => a.lineStart - b.lineStart || a.name.localeCompare(b.name))
  return symbols
}

// ─── Operation implementations (mirror batch::op_*) ────────────────────────

type OpResult = { ok: true; value: unknown } | { ok: false; code: string; message: string }

/** `read`: TextResult for raw/non-code, CodeResult for code files otherwise. */
function opRead(params: OperationParams, cwd: string | undefined): OpResult {
  if (!params.file) return errResult(E_BAD_REQUEST, "read requires 'file'")
  const path = resolvePath(params.file, cwd)
  let source: string
  try {
    source = readFileSync(path, "utf-8")
  } catch (e) {
    // Mirror Rust io::Error Display: "No such file or directory (os error 2)".
    return errResult(E_INTERNAL, `read failed: ${ioErrorText(e)}`)
  }
  const mode = params.mode ?? "auto"
  if (!["auto", "raw", "prototype", "deep"].includes(mode)) {
    return errResult(E_BAD_REQUEST, `invalid read mode: Unknown read mode: ${params.mode}`)
  }
  const effective =
    mode === "auto" ? (isCodeFile(path) ? "prototype" : "raw") : mode

  if (effective === "raw") {
    const allLines = splitLines(source)
    const totalLines = allLines.length
    const offset = params.offset ?? 1
    const start = Math.max(0, Math.min(offset - 1, totalLines))
    const end = params.limit !== undefined ? Math.min(start + params.limit, totalLines) : totalLines
    const lines = allLines.slice(start, end)
    return {
      ok: true,
      value: {
        path,
        language: "text",
        mode: "raw",
        total_lines: totalLines,
        offset,
        returned_lines: lines.length,
        lines,
        // reader/text.rs serializes parse_error unconditionally (no
        // skip_serializing_if), so the wire includes it as null.
        parse_error: null,
      },
    }
  }

  // prototype / deep → CodeResult (regex symbols; dependencies mirror the
  // prototype reader, which emits an empty dependency list).
  const totalLines = splitLines(source).length
  const language = detectLanguage(path) ?? "text"
  const symbols = scanSymbols(source).map((s) => ({
    kind: s.kind,
    name: s.name,
    signature: s.signature,
    line_start: s.lineStart,
    line_end: s.lineEnd,
    parent_scope: "module:top",
  }))
  return {
    ok: true,
    value: {
      path,
      language,
      mode: effective,
      total_lines: totalLines,
      symbols,
      dependencies: [],
    },
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** `grep`: mirrors reader/grep.rs `grep_files` (merged context windows). */
function opGrep(params: OperationParams, cwd: string | undefined): OpResult {
  if (!params.pattern) return errResult(E_BAD_REQUEST, "grep requires 'pattern'")
  const contextLines = Math.min(params.contextLines ?? 2, ABSOLUTE_MAX_CONTEXT)
  const maxMatches = Math.min(params.maxMatches ?? 50, ABSOLUTE_MAX_MATCHES)
  const fixedStrings = params.fixedStrings ?? false
  const caseSensitive = params.caseSensitive ?? false

  let regex: RegExp
  try {
    regex = new RegExp(fixedStrings ? escapeRegex(params.pattern) : params.pattern, caseSensitive ? "" : "i")
  } catch (e) {
    return errResult(E_INTERNAL, `grep failed: invalid regex: ${e instanceof Error ? e.message : String(e)}`)
  }

  const paths = resolvePaths(params.paths, cwd)
  const files = collectFiles(paths, "text")
  const allResults: Array<{ path: string; matches: unknown[] }> = []
  let totalMatches = 0
  let truncated = false

  for (const file of files) {
    if (totalMatches >= maxMatches) {
      truncated = true
      break
    }
    let lines: string[]
    try {
      lines = splitLines(readFileSync(file, "utf-8"))
    } catch {
      continue
    }
    const matchLines: number[] = []
    for (let idx = 0; idx < lines.length; idx++) {
      if (regex.test(lines[idx])) {
        matchLines.push(idx + 1)
      }
    }
    if (matchLines.length === 0) continue

    const ranges = mergeContextRanges(matchLines, contextLines, lines.length)
    const fileMatches: unknown[] = []
    for (const [start, end, mLines] of ranges) {
      if (totalMatches >= maxMatches) {
        truncated = true
        break
      }
      const contextBefore = start > 1 ? lines.slice(start - 2, start - 1) : []
      const contextAfter = end < lines.length ? lines.slice(end, end + 1) : []
      const primaryLine = mLines[0] ?? start
      fileMatches.push({
        line_number: primaryLine,
        text: lines[primaryLine - 1],
        context_before: contextBefore,
        context_after: contextAfter,
      })
      totalMatches += mLines.length
    }
    if (fileMatches.length > 0) {
      allResults.push({ path: file, matches: fileMatches })
    }
  }

  return {
    ok: true,
    value: {
      total_matches: totalMatches,
      truncated,
      tee_path: null,
      files: allResults,
    },
  }
}

/** Merge adjacent/overlapping context windows (mirror merge_context_ranges). */
function mergeContextRanges(
  matchLines: number[],
  context: number,
  totalLines: number,
): Array<[number, number, number[]]> {
  if (matchLines.length === 0) return []
  const ranges: Array<[number, number, number[]]> = []
  const firstStart = Math.max(1, matchLines[0] - context)
  const firstEnd = Math.min(totalLines, matchLines[0] + context)
  ranges.push([firstStart, firstEnd, [matchLines[0]]])
  for (let i = 1; i < matchLines.length; i++) {
    const line = matchLines[i]
    const last = ranges[ranges.length - 1]
    if (line <= last[1] + 1) {
      const newEnd = Math.min(totalLines, line + context)
      last[1] = newEnd
      last[2].push(line)
    } else {
      const s = Math.max(1, line - context)
      const e = Math.min(totalLines, line + context)
      ranges.push([s, e, [line]])
    }
  }
  return ranges
}

/** `search`: case-insensitive substring match on symbol names (reader/search.rs). */
function opSearch(params: OperationParams, cwd: string | undefined): OpResult {
  if (!params.pattern) return errResult(E_BAD_REQUEST, "search requires 'pattern'")
  const maxMatches = params.maxMatches ?? 50
  if (maxMatches === 0) {
    return { ok: true, value: { pattern: params.pattern, total_matches: 0, matches: [] } }
  }
  const kindFilter = params.kindFilter && params.kindFilter !== "any" ? params.kindFilter : undefined
  const patternLower = params.pattern.toLowerCase()
  const paths = resolvePaths(params.paths, cwd)
  const files = collectFiles(paths, "code")
  const matches: Array<{ file: string; symbol: unknown }> = []

  for (const file of files) {
    if (matches.length >= maxMatches) break
    let source: string
    try {
      source = readFileSync(file, "utf-8")
    } catch {
      continue
    }
    for (const sym of scanSymbols(source)) {
      if (matches.length >= maxMatches) break
      if (!sym.name.toLowerCase().includes(patternLower)) continue
      if (kindFilter && sym.kind !== kindFilter) continue
      matches.push({
        file,
        symbol: {
          kind: sym.kind,
          name: sym.name,
          signature: sym.signature,
          line_start: sym.lineStart,
          line_end: sym.lineEnd,
          parent_scope: "module:top",
        },
      })
    }
  }

  return {
    ok: true,
    value: { pattern: params.pattern, total_matches: matches.length, matches },
  }
}

/** `outline`: mirrors reader/outline JSON shape (comma-split kind filter). */
function opOutline(params: OperationParams, cwd: string | undefined): OpResult {
  const paths = resolvePaths(params.paths, cwd)
  const kindFilter = params.kindFilter
    ? params.kindFilter.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
    : undefined
  const minLines = params.minLines ?? 1

  const files = collectFiles(paths, "code")
  const results: Array<Record<string, unknown>> = []
  for (const file of files) {
    let source: string
    try {
      source = readFileSync(file, "utf-8")
    } catch {
      continue
    }
    const totalLines = splitLines(source).length
    let symbols = scanSymbols(source)
    if (kindFilter && kindFilter.length > 0) {
      symbols = symbols.filter((s) => kindFilter.includes(s.kind))
    }
    if (minLines > 1) {
      symbols = symbols.filter((s) => s.lineEnd - s.lineStart + 1 >= minLines)
    }
    results.push({
      path: file,
      language: detectLanguage(file) ?? "text",
      total_lines: totalLines,
      symbols: symbols.map((s) => ({
        kind: s.kind,
        name: s.name,
        signature: s.signature,
        doc_comment: null,
        line_start: s.lineStart,
        line_end: s.lineEnd,
      })),
      parse_error: null,
    })
  }

  const totalSymbols = results.reduce((acc, r) => acc + (r.symbols as unknown[]).length, 0)
  const totalLines = results.reduce((acc, r) => acc + (r.total_lines as number), 0)
  return {
    ok: true,
    value: { total_files: results.length, total_symbols: totalSymbols, total_lines: totalLines, files: results },
  }
}

/** `impact`: import-based dependency scan mirroring reader/impact.rs. */
function opImpact(params: OperationParams, cwd: string | undefined): OpResult {
  const targets = resolvePaths(params.targets, cwd)
  if (targets.length === 0) {
    return errResult(E_BAD_REQUEST, "impact requires at least one 'targets' entry")
  }
  const root = params.root ? resolvePath(params.root, cwd) : (cwd ?? ".")
  const direction = params.direction ?? "both"
  if (!["in", "out", "both"].includes(direction)) {
    return errResult(E_BAD_REQUEST, `invalid impact direction: Unknown direction: ${direction}`)
  }
  const depth = params.depth ?? 1
  if (depth > 1) {
    return errResult(
      E_INTERNAL,
      "Impact analysis depth > 1 is not supported until full multi-level dependency graph traversal is implemented; specify --depth 1",
    )
  }

  const results: Array<Record<string, unknown>> = []
  for (const target of targets) {
    let targetSource: string
    try {
      targetSource = readFileSync(target, "utf-8")
    } catch {
      continue
    }
    const outbound =
      direction === "out" || direction === "both"
        ? findOutboundDeps(target, targetSource, root)
        : []
    const inbound =
      direction === "in" || direction === "both"
        ? findInboundDeps(target, root)
        : []
    results.push({ target, depth, outbound, inbound })
  }

  return { ok: true, value: results }
}

/** Imports declared by `source` (relative/bare specifiers), mirrored to dep
 * entries with the native wire shape (symbols_used/at_lines null when empty). */
function findOutboundDeps(target: string, source: string, root: string): unknown[] {
  const deps: Array<{ path: string | null; resolved: boolean; name: string; symbols_used: string[] | null; at_lines: number[] | null; prototypes: unknown[] }> = []
  const seen = new Set<string>()
  const importRe = /(?:import\s+[^'"]*from\s+['"]|import\s*\(\s*['"]|require\(\s*['"])([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = importRe.exec(source)) !== null) {
    const spec = m[1]
    if (!spec.startsWith(".")) continue
    const lineNumber = source.slice(0, m.index).split("\n").length
    const candidate = join(root, spec)
    if (seen.has(candidate)) continue
    seen.add(candidate)
    const exists = existsSync(candidate) || existsSync(candidate + ".ts") || existsSync(candidate + ".tsx") || existsSync(candidate + ".js")
    deps.push({
      path: exists ? (existsSync(candidate) ? candidate : findExisting(candidate)) : null,
      resolved: exists,
      name: spec,
      symbols_used: null,
      at_lines: [lineNumber],
      prototypes: [],
    })
  }
  return deps
}

function findExisting(base: string): string {
  for (const ext of [".ts", ".tsx", ".js", ".jsx"]) {
    const p = base + ext
    if (existsSync(p)) return p
  }
  return base
}

/** Files under root whose imports reference `target` by module name. */
function findInboundDeps(target: string, root: string): unknown[] {
  const baseName = target.split("/").pop() ?? target
  const moduleName = baseName.replace(/\.(ts|tsx|js|jsx)$/, "")
  const deps: Array<{ path: string | null; resolved: boolean; name: string; symbols_used: string[] | null; at_lines: number[] | null; prototypes: unknown[] }> = []
  const files = collectFiles([root], "code")
  for (const file of files) {
    if (resolve(file) === resolve(target)) continue
    let source: string
    try {
      source = readFileSync(file, "utf-8")
    } catch {
      continue
    }
    const importRe = /(?:from\s+['"]|import\s*\(\s*['"]|require\(\s*['"])([^'"]+)['"]/g
    let m: RegExpExecArray | null
    while ((m = importRe.exec(source)) !== null) {
      const spec = m[1]
      const specBase = (spec.split("/").pop() ?? spec).replace(/\.(ts|tsx|js|jsx)$/, "")
      if (specBase === moduleName) {
        const lineNumber = source.slice(0, m.index).split("\n").length
        deps.push({
          path: file,
          resolved: true,
          name: moduleName,
          symbols_used: null,
          at_lines: [lineNumber],
          prototypes: [],
        })
        break
      }
    }
  }
  return deps
}

/** `testsFor`: no snapshot in the fallback — same E_INTERNAL as native. */
function opTestsFor(params: OperationParams): OpResult {
  if (!params.source) return errResult(E_BAD_REQUEST, "testsFor requires 'source'")
  return errResult(E_INTERNAL, "testsFor requires an index snapshot; run index.refresh first")
}

function errResult(code: string, message: string): OpResult {
  return { ok: false, code, message }
}

/** Map a Node fs error to the Rust io::Error Display the native executor emits
 * ("<message> (os error <errno>)"). Falls back to the Node message text for
 * errnos without a mapping (shape parity holds). */
function ioErrorText(e: unknown): string {
  const err = e as { code?: string; message?: string } | null
  const code = err?.code ?? ""
  const table: Record<string, [string, number]> = {
    ENOENT: ["No such file or directory", 2],
    EACCES: ["Permission denied", 13],
    EISDIR: ["Is a directory", 21],
    EINVAL: ["Invalid argument", 22],
    ENAMETOOLONG: ["File name too long", 36],
    ELOOP: ["Too many levels of symbolic links", 40],
  }
  const mapped = table[code]
  if (mapped) return `${mapped[0]} (os error ${mapped[1]})`
  return err?.message ?? String(e)
}

// ─── Output bounding (mirror batch::finalize_response) ─────────────────────

/** Make an op id safe as a file name (mirror batch::sanitize_artifact_name). */
export function sanitizeArtifactName(id: string): string {
  const out = id.replace(/[^A-Za-z0-9_-]/g, "_")
  const bounded = out.length > 32 ? out.slice(0, 32) : out
  return bounded.length > 0 ? bounded : "op"
}

/**
 * Content-addressed artifact file name for an op id (mirror
 * batch::artifact_file_name): `<safe-prefix>-<op-id-hash>-<content-hash>.json`
 *
 * - safe-prefix: bounded sanitized operation ID (max 32 chars)
 * - op-id-hash: full SHA-256 of the operation ID
 * - content-hash: full SHA-256 of the artifact content
 *
 * Guarantees distinct IDs never collide, same ID with different content never
 * overwrites, and concurrent batches with identical ID+content safely reuse.
 */
export function artifactFileName(id: string, contentHash: string): string {
  const prefix = sanitizeArtifactName(id)
  const opIdHash = sha256Hex(Buffer.from(id, "utf-8"))
  return `${prefix}-${opIdHash}-${contentHash}.json`
}

/** Human-readable error message (mirrors ioErrorText semantics for artifacts). */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Write `bytes` to `fd` in a loop until the ENTIRE buffer is stored (P1-4).
 * A single writeSync may legally complete fewer bytes than requested; only
 * looping from the returned offset guarantees a complete artifact file. Fails
 * closed on zero progress or any write error — a partial file must never be
 * activated under a hash computed from the intended full payload.
 */
function writeExact(fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset)
    if (written <= 0) {
      throw new Error(`write made no progress after ${offset}/${bytes.length} bytes`)
    }
    offset += written
  }
}

/**
 * A provisional artifact: an exclusively-created, fully-written and fsynced
 * temp file that is NOT yet visible at the final content-addressed path.
 */
interface ProvisionalArtifact {
  /** Temp path (same directory as final, so rename is same-filesystem). */
  tempPath: string
  finalPath: string
  contentHash: string

  /** Remove the provisional temp file (no-op for the reuse marker). */
  discard(): void

  /**
   * Atomically activate with no-clobber semantics. Returns an ownership
   * outcome: `created` when THIS call published the file (the transaction
   * owns it and may roll it back), or `reused-existing` when the path already
   * held identical content (the transaction does NOT own it).
   */
  activate(bytes: Buffer, contentHash: string): ArtifactActivation
}

/** Ownership outcome of an artifact activation (P1-3, TS mirror). */
interface ArtifactActivation {
  kind: "created" | "reused-existing"
  path: string
}

/**
 * Prepare a provisional artifact: create a unique sibling temp file with
 * exclusive creation (O_CREAT|O_EXCL via the `wx` flag), write the complete
 * bytes, fsync the file, and close it. If `finalPath` already exists with
 * identical content the file is reused (no temp write); if it exists with
 * different content the write fails closed. Only ENOENT permits creation to
 * proceed — permission, I/O, corruption, and unexpected read errors all fail
 * closed. Temp names embed a random nonce and cannot be guessed or shared
 * unsafely; exclusive creation guarantees we never truncate another writer's
 * temp file.
 */
function prepareArtifact(finalPath: string, bytes: Buffer, contentHash: string): ProvisionalArtifact {
  // Reuse an existing correct artifact (content-addressed deduplication).
  try {
    const existing = readFileSync(finalPath)
    if (sha256Hex(existing) === contentHash && existing.length === bytes.length) {
      return {
        tempPath: finalPath, // reuse marker: activation is a no-op
        finalPath,
        contentHash,
        discard() {},
        activate() {
          return { kind: "reused-existing", path: finalPath }
        },
      }
    }
    throw new Error(`artifact path already exists with different content: ${finalPath}`)
  } catch (e) {
    if (e instanceof Error && e.message.includes("artifact path already exists with different content")) {
      throw e
    }
    // Only ENOENT permits creation to proceed.
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`failed to read existing artifact: ${errorText(e)}`)
    }
  }

  mkdirSync(join(finalPath, ".."), { recursive: true })

  // Exclusive sibling temp creation (wx = O_CREAT|O_EXCL). The name embeds a
  // random nonce so it cannot be guessed or shared unsafely.
  const dir = join(finalPath, "..")
  const base = join(dir, `.${finalPath.split(/[/\\]/).pop()}`)
  let lastErr: unknown
  for (let attempt = 0; attempt < 100; attempt++) {
    const tempPath = `${base}.${cryptoRandomNonce()}.${attempt}.tmp`
    let fd: number | null = null
    try {
      fd = openSync(tempPath, "wx")
      writeExact(fd, bytes)
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      return {
        tempPath,
        finalPath,
        contentHash,
        discard() {
          try {
            unlinkSync(tempPath)
          } catch {
            // best-effort cleanup
          }
        },
        activate(targetBytes, targetHash) {
          if (tempPath === finalPath) {
            // Reuse case: the correct artifact was already published by an
            // earlier writer. This transaction does NOT own it — but it is
            // REVALIDATED now (P1-5): another process may have deleted or
            // replaced the file between preparation and activation. Regular
            // file identity, size and digest must all still match.
            const st = statSync(finalPath)
            if (!st.isFile() || st.size !== targetBytes.length) {
              throw new Error(
                `reused artifact ${finalPath} no longer valid (size or type changed)`,
              )
            }
            const existing = readFileSync(finalPath)
            if (sha256Hex(existing) !== targetHash) {
              throw new Error(`reused artifact ${finalPath} content changed (digest mismatch)`)
            }
            return { kind: "reused-existing", path: finalPath }
          }
          // No-clobber publish: link the fully-written+fsynced temp into the
          // final name, then remove the temp name. linkSync fails with EEXIST
          // when a competing writer already activated the final path — unlike
          // renameSync, which silently REPLACES the destination on POSIX. A
          // racing writer therefore always enters winner verification.
          try {
            linkSync(tempPath, finalPath)
            try {
              unlinkSync(tempPath)
            } catch {
              // temp already gone
            }
            // Directory durability (P2-4): fsyncDir ignores only documented
            // unsupported-platform signals and propagates genuine failures.
            // On a genuine fsync failure the just-created final artifact is
            // removed and the combined activation/cleanup error returned, so
            // the publish is never reported durable when it was not (P1-3).
            try {
              fsyncDir(join(finalPath, ".."))
            } catch (syncErr) {
              try {
                unlinkSync(finalPath)
              } catch {
                // best-effort cleanup
              }
              throw new Error(
                `failed to fsync artifact dir after publish (artifact removed): ${errorText(syncErr)}`,
              )
            }
            return { kind: "created", path: finalPath }
          } catch (linkErr) {
            if (linkErr instanceof Error && (linkErr as NodeJS.ErrnoException).code === "EEXIST") {
              // A competing winner activated the final path first. Read and
              // verify it before reuse; never clobber it.
              try {
                const existing = readFileSync(finalPath)
                if (sha256Hex(existing) === targetHash && existing.length === targetBytes.length) {
                  // Identical content: safely reuse the winner. We do not own
                  // it, so it is never journaled for rollback.
                  try {
                    unlinkSync(tempPath)
                  } catch {
                    // temp already gone
                  }
                  return { kind: "reused-existing", path: finalPath }
                }
                throw new Error(`artifact path already exists with different content: ${finalPath}`)
              } catch (readErr) {
                if (
                  readErr instanceof Error &&
                  readErr.message.includes("artifact path already exists with different content")
                ) {
                  try {
                    unlinkSync(tempPath)
                  } catch {
                    // best effort
                  }
                  throw readErr
                }
                try {
                  unlinkSync(tempPath)
                } catch {
                  // best effort
                }
                throw new Error(
                  `failed to publish artifact (no-clobber): ${errorText(linkErr)}; final unreadable: ${errorText(readErr)}`,
                )
              }
            }
            // Unexpected link failure (permission, I/O, unsupported FS):
            // fail closed; never fall back to a clobbering rename.
            try {
              unlinkSync(tempPath)
            } catch {
              // best effort
            }
            throw new Error(`failed to publish artifact (no-clobber): ${errorText(linkErr)}`)
          }
        },
      }
    } catch (e) {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          // ignore close failure during error path
        }
      }
      try {
        unlinkSync(tempPath)
      } catch {
        // temp may not exist
      }
      if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "EEXIST") {
        lastErr = e
        continue // another writer holds this temp name; try the next nonce
      }
      throw new Error(`failed to write temp artifact: ${errorText(e)}`)
    }
  }
  throw new Error(`too many temp file collisions: ${errorText(lastErr)}`)
}

/** Best-effort directory fsync (supported on Linux/macOS; no-op where not). */
function fsyncDir(dir: string): void {
  // P2-4 durability with documented platform handling: directory fsync is
  // unsupported on Windows (a directory cannot be opened for sync) — a
  // platform limitation, not a durability failure, so it is skipped there.
  // On Unix, genuine failures (EIO, EACCES, ENOSPC, EROFS, EBUSY) MUST
  // propagate; only documented filesystem-unsupported signals are ignored.
  if (process.platform === "win32") return
  try {
    const fd = openSync(dir, "r")
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // Ignore ONLY documented unsupported-filesystem signals (some
    // filesystems cannot fsync a directory); propagate everything else.
    const unsupported = ["EINVAL", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "EBADF"]
    if (!unsupported.includes(code ?? "")) {
      throw e
    }
  }
}

/** Unpredictable nonce for temp file names (time + pid + random). */
function cryptoRandomNonce(): string {
  const t = Date.now().toString(36)
  const p = (process.pid || 0).toString(36)
  const r = Math.random().toString(36).slice(2, 10)
  return `${t}-${p}-${r}`
}

/** SHA-256 hex digest of a byte slice (artifact content integrity). */
function sha256Hex(bytes: Buffer): string {
  const crypto = require("node:crypto") as typeof import("node:crypto")
  return crypto.createHash("sha256").update(bytes).digest("hex")
}

// ─── Parameter preflight validators (mirror batch::validate_operation_params) ──

function validateOperationParams(op: BatchOperation): void {
  switch (op.op) {
    case "read":
      validateReadParams(op.params)
      break
    case "grep":
      validateGrepParams(op.params)
      break
    case "search":
      validateSearchParams(op.params)
      break
    case "outline":
      validateOutlineParams(op.params)
      break
    case "impact":
      validateImpactParams(op.params)
      break
    case "testsFor":
      validateTestsForParams(op.params)
      break
    default:
      // Unknown ops are already rejected by descriptor preflight.
      break
  }
}

function validateReadParams(params: OperationParams): void {
  if (!params.file) {
    throw new BatchRejectError(E_BAD_REQUEST, "operation 'read': read requires 'file'")
  }
  if (params.file.trim().length === 0) {
    throw new BatchRejectError(E_BAD_REQUEST, "operation 'read': read 'file' must not be empty")
  }
  if (params.file.includes("\0")) {
    throw new BatchRejectError(E_BAD_REQUEST, "operation 'read': read 'file' contains embedded NUL")
  }
  const mode = params.mode ?? "auto"
  if (!["auto", "raw", "prototype", "deep"].includes(mode)) {
    throw new BatchRejectError(E_BAD_REQUEST, `operation 'read': invalid read mode: ${mode}`)
  }
  if (mode === "raw" && params.symbol) {
    throw new BatchRejectError(E_BAD_REQUEST, "operation 'read': read 'symbol' is not valid with mode 'raw'")
  }
  if (params.limit !== undefined) {
    if (params.limit <= 0 || params.limit > 10_000) {
      throw new BatchRejectError(E_BAD_REQUEST, `operation 'read': read 'limit' must be in 1..=10000, got ${params.limit}`)
    }
  }
  if (params.offset !== undefined) {
    if (params.offset <= 0 || params.offset > 1_000_000) {
      throw new BatchRejectError(E_BAD_REQUEST, `operation 'read': read 'offset' must be in 1..=1000000, got ${params.offset}`)
    }
  }
}

function validateGrepParams(params: OperationParams): void {
  if (!params.pattern) {
    throw new BatchRejectError(E_BAD_REQUEST, "operation 'grep': grep requires 'pattern'")
  }
  if (params.pattern.trim().length === 0) {
    throw new BatchRejectError(E_BAD_REQUEST, "operation 'grep': grep 'pattern' must not be empty")
  }
  if (!params.fixedStrings) {
    try {
      new RegExp(params.pattern)
    } catch (e) {
      throw new BatchRejectError(E_BAD_REQUEST, `operation 'grep': grep 'pattern' is not a valid regex: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (params.contextLines !== undefined && params.contextLines > 3) {
    throw new BatchRejectError(E_BAD_REQUEST, `operation 'grep': grep 'context_lines' must be <= 3, got ${params.contextLines}`)
  }
  if (params.maxMatches !== undefined) {
    if (params.maxMatches <= 0 || params.maxMatches > 200) {
      throw new BatchRejectError(E_BAD_REQUEST, `operation 'grep': grep 'max_matches' must be in 1..=200, got ${params.maxMatches}`)
    }
  }
  for (const path of params.paths ?? []) {
    if (path.includes("\0")) {
      throw new BatchRejectError(E_BAD_REQUEST, "operation 'grep': grep 'paths' contains embedded NUL")
    }
  }
}

function validateSearchParams(params: OperationParams): void {
  if (!params.pattern) {
    throw new BatchRejectError(E_BAD_REQUEST, "operation 'search': search requires 'pattern'")
  }
  if (params.pattern.trim().length === 0) {
    throw new BatchRejectError(E_BAD_REQUEST, "operation 'search': search 'pattern' must not be empty")
  }
  if (params.kindFilter) {
    const supported = ["any", "function", "class", "struct", "trait", "enum", "const", "type"]
    if (!supported.includes(params.kindFilter)) {
      throw new BatchRejectError(E_BAD_REQUEST, `operation 'search': search 'kind_filter' is not supported: ${params.kindFilter}`)
    }
  }
  if (params.maxMatches !== undefined) {
    if (params.maxMatches <= 0 || params.maxMatches > 500) {
      throw new BatchRejectError(E_BAD_REQUEST, `operation 'search': search 'max_matches' must be in 1..=500, got ${params.maxMatches}`)
    }
  }
}

function validateOutlineParams(params: OperationParams): void {
  if (params.depth !== undefined) {
    if (params.depth <= 0 || params.depth > 10) {
      throw new BatchRejectError(E_BAD_REQUEST, `operation 'outline': outline 'depth' must be in 1..=10, got ${params.depth}`)
    }
  }
  if (params.minLines !== undefined) {
    if (params.minLines <= 0 || params.minLines > 1000) {
      throw new BatchRejectError(E_BAD_REQUEST, `operation 'outline': outline 'min_lines' must be in 1..=1000, got ${params.minLines}`)
    }
  }
  for (const path of params.paths ?? []) {
    if (path.includes("\0")) {
      throw new BatchRejectError(E_BAD_REQUEST, "operation 'outline': outline 'paths' contains embedded NUL")
    }
  }
}

function validateImpactParams(params: OperationParams): void {
  if (!params.targets || params.targets.length === 0) {
    throw new BatchRejectError(E_BAD_REQUEST, "operation 'impact': impact requires at least one 'targets' entry")
  }
  const direction = params.direction ?? "both"
  if (!["in", "out", "both"].includes(direction)) {
    throw new BatchRejectError(E_BAD_REQUEST, `operation 'impact': invalid impact direction: ${direction}`)
  }
  if (params.depth !== undefined && params.depth !== 1) {
    throw new BatchRejectError(E_BAD_REQUEST, `operation 'impact': impact 'depth' must be 1, got ${params.depth}`)
  }
  if (params.root && params.root.includes("\0")) {
    throw new BatchRejectError(E_BAD_REQUEST, "operation 'impact': impact 'root' contains embedded NUL")
  }
  for (const target of params.targets) {
    if (target.includes("\0")) {
      throw new BatchRejectError(E_BAD_REQUEST, "operation 'impact': impact 'targets' contains embedded NUL")
    }
  }
}

function validateTestsForParams(params: OperationParams): void {
  if (!params.source) {
    throw new BatchRejectError(E_BAD_REQUEST, "operation 'testsFor': testsFor requires 'source'")
  }
  if (params.source.trim().length === 0) {
    throw new BatchRejectError(E_BAD_REQUEST, "operation 'testsFor': testsFor 'source' must not be empty")
  }
  if (params.source.includes("\0")) {
    throw new BatchRejectError(E_BAD_REQUEST, "operation 'testsFor': testsFor 'source' contains embedded NUL")
  }
}

// ─── Executor (mirror batch::execute_batch) ────────────────────────────────

export interface BatchFallbackOptions {
  failFast?: boolean
  /** Base directory for truncation artifacts (default: system temp dir). */
  artifactBase?: string
  /**
   * Repository-state probe (mirror batch::execute_batch_with_probe test
   * seam). Defaults to a git-backed [`createRepoStateProbe`] for `cwd`; pass
   * `null` to disable probing entirely, or a scripted probe for tests.
   */
  probe?: BatchStateProbe | null
}

/**
 * Pure-TS batch executor. Throws `BatchRejectError` for whole-batch
 * violations: structural (empty / over-capacity / duplicate ids) AND
 * per-operation validity (ANY unknown / mutating / non-batchable op rejects
 * the ENTIRE batch with E_BAD_REQUEST before anything executes — zero
 * execution). Otherwise returns a `BatchResponse` with input-order responses,
 * per-op errors inside the envelope, and a state-probed `staleSnapshot`.
 *
 * With `failFast: true` the batch stops executing at the first failed
 * operation: every unstarted operation is returned as an explicit
 * `E_CANCELLED` response (never executed). If the repository state drifts
 * mid-batch (HEAD / dirty tree / config changed), every remaining operation
 * is returned as an explicit `E_STALE_SNAPSHOT` response (never executed)
 * and `staleSnapshot` is `true` — mirroring the native executor. In both
 * cases the response always contains exactly one entry per input operation.
 */
export function executeBatchFallback(
  operations: BatchOperation[],
  cwd?: string,
  options: BatchFallbackOptions = {},
): BatchResponse {
  if (operations.length === 0) {
    throw new BatchRejectError(E_BAD_REQUEST, "batch.operations must not be empty")
  }
  if (operations.length > TS_MAX_BATCH_OPS) {
    throw new BatchRejectError(
      E_BAD_REQUEST,
      `batch.operations exceeds the maximum of ${TS_MAX_BATCH_OPS} operations`,
    )
  }
  const seen = new Set<string>()
  for (const op of operations) {
    if (seen.has(op.id)) {
      throw new BatchRejectError(E_BAD_REQUEST, `duplicate batch operation id '${op.id}'`)
    }
    seen.add(op.id)
  }

  // Whole-batch preflight: every operation must be a known, read-only,
  // batchable op. An invalid operation rejects the ENTIRE batch before ANY
  // operation executes — zero execution, no partial results (mirrors the
  // native executor's preflight).
  for (const op of operations) {
    const descriptor = tsToolDescriptor(op.op)
    const message = descriptor
      ? !descriptor.readOnly
        ? `operation '${op.op}' is not read-only and cannot run in a batch`
        : !descriptor.supportsBatching
          ? `operation '${op.op}' does not support batching`
          : null
      : `unknown batch operation '${op.op}'`
    if (message !== null) {
      throw new BatchRejectError(E_BAD_REQUEST, message)
    }
  }

  // Parameter preflight: validate every operation's request parameters
  // before any operation executes. An invalid parameter set rejects the
  // ENTIRE batch with E_BAD_REQUEST — zero execution, no cache reads or
  // writes, no artifact files.
  for (const op of operations) {
    validateOperationParams(op)
  }

  // Repository-state probe: an explicitly injected probe wins; otherwise a
  // git-backed probe for the cwd; pass null to disable. The probe is
  // consulted before each operation and once more before the final response
  // is emitted, mirroring the native executor.
  const probe: BatchStateProbe | null =
    options.probe !== undefined ? options.probe : createRepoStateProbe(cwd)

  let usedOutputBytes = 0
  let failedFast = false
  let staleSnapshot = false
  // Deferred-activation transaction: each op stages either a final response or
  // a PENDING activation (provisional artifact temp). Pending activations are
  // committed ONLY after the final state fence passes; on drift they are
  // discarded so no artifact from this batch becomes visible. The per-op
  // outcomes keep input order for exact response reconstruction.
  type StagedOutcome =
    | { kind: "final"; resp: OperationResponse }
    | { kind: "pending"; pending: PendingFallbackActivation }
  const staged: StagedOutcome[] = []
  for (const op of operations) {
    if (failedFast) {
      // Cardinality contract: every input operation gets exactly one
      // response. Operations that never started (fail-fast) return an
      // explicit cancellation response and are never executed — mirroring
      // the native executor (batch::execute_batch).
      staged.push({
        kind: "final",
        resp: {
          id: op.id,
          ok: false,
          error: { code: E_CANCELLED, message: "operation cancelled by fail-fast" },
        },
      })
      continue
    }
    // Repository-state drift: once the captured state no longer matches the
    // worktree, every remaining operation is ABORTED — never executed.
    if (staleSnapshot) {
      staged.push({
        kind: "final",
        resp: {
          id: op.id,
          ok: false,
          error: {
            code: E_STALE_SNAPSHOT,
            message: "operation aborted: repository state changed mid-batch",
          },
        },
      })
      continue
    }
    // Revalidate the captured repository state before each operation so
    // drift is detected even for ops that never touch the cache.
    if (probe !== null && !probe.stateUnchanged()) {
      staleSnapshot = true
      staged.push({
        kind: "final",
        resp: {
          id: op.id,
          ok: false,
          error: {
            code: E_STALE_SNAPSHOT,
            message: "operation aborted: repository state changed mid-batch",
          },
        },
      })
      continue
    }
    const budget = TS_MAX_BATCH_OUTPUT_BYTES - usedOutputBytes
    const outcome = runFallbackOperation(op, cwd, budget, options.artifactBase, probe)
    if (outcome.kind === "final") {
      usedOutputBytes += outcome.used
      staged.push({ kind: "final", resp: outcome.resp })
      if (!outcome.resp.ok && options.failFast === true) {
        failedFast = true
      }
    } else {
      usedOutputBytes += outcome.pending.used
      staged.push({ kind: "pending", pending: outcome.pending })
    }
  }

  // FINAL STATE FENCE — the batch commit decision. A repository mutation
  // detected here (or earlier, mid-batch) invalidates EVERY pending
  // activation: no artifact from this batch becomes visible.
  if (!staleSnapshot && probe !== null && !probe.stateUnchanged()) {
    staleSnapshot = true
  }

  // Resolve staged outcomes with a true all-or-nothing transaction (P1-5):
  //   Phase A — activate every pending artifact (no-clobber, ownership-aware;
  //     only created artifacts are rollback-owned).
  //   Phase B — POST-ACTIVATION state probe: the repository may have changed
  //     during activation. If so, roll back every owned artifact.
  //   Only when both phases succeed are responses built as success. On any
  //   failure EVERY provisional op becomes a stable error and NO success
  //   response references a rolled-back output.
  const pendings: PendingFallbackActivation[] = []
  for (const outcome of staged) {
    if (outcome.kind === "pending") {
      pendings.push(outcome.pending)
    }
  }

  let txnError: string | null = null
  if (!staleSnapshot && pendings.length > 0) {
    // Phase A: activate every artifact.
    for (const pending of pendings) {
      try {
        pending.activateArtifact()
      } catch (e) {
        txnError = `failed to write artifact: ${errorText(e)}`
        break
      }
    }
    // Phase B: POST-ACTIVATION state probe.
    if (txnError === null && probe !== null && !probe.stateUnchanged()) {
      staleSnapshot = true
    }
    // Phase C2 (P1-3): revalidate EVERY activated artifact BEFORE global
    // success. A final-validation failure is a TRANSACTION failure — it
    // converts every provisional response to a stable error; success
    // responses are only constructed after ALL validations pass.
    if (txnError === null && !staleSnapshot) {
      for (const pending of pendings) {
        try {
          pending.validateArtifact()
        } catch (e) {
          txnError = `artifact no longer valid at finalization: ${errorText(e)}`
          break
        }
      }
    }
  }

  const failed = staleSnapshot || txnError !== null
  // P2-5: rollback returns a structured report; an incomplete rollback is
  // surfaced distinctly as ROLLBACK INCOMPLETE.
  const rollbackIssues: string[] = []
  const responses: OperationResponse[] = []
  for (const outcome of staged) {
    if (outcome.kind === "final") {
      responses.push(outcome.resp)
      continue
    }
    const pending = outcome.pending
    if (!failed) {
      responses.push(pending.buildResponse())
      continue
    }
    // Roll back (temps only; published artifacts are immutable) and collect
    // any cleanup failure.
    rollbackIssues.push(...pending.rollback())
    if (staleSnapshot) {
      responses.push({
        id: pending.id,
        ok: false,
        error: {
          code: E_STALE_SNAPSHOT,
          message: "operation result discarded: repository state changed during execution",
        },
      })
    } else {
      let msg = txnError ?? "batch activation failed"
      if (rollbackIssues.length > 0) {
        msg = `${msg}; ROLLBACK INCOMPLETE: ${rollbackIssues.join("; ")}`
      }
      responses.push({
        id: pending.id,
        ok: false,
        error: { code: E_INTERNAL, message: msg },
      })
    }
  }

  return { version: 1, responses, failedFast, staleSnapshot }
}

/**
 * A provisional artifact activation staged by an operation, awaiting the batch
 * final state fence. The temp file is fully written (write-exact), fsynced and
 * closed, but NOT yet published at the final path.
 */
interface PendingFallbackActivation {
  id: string
  used: number
  limit: number
  bytes: Buffer
  contentHash: string
  artifact: ProvisionalArtifact | null
  value: unknown
  /** Final artifact path once activated (null until commit). */
  artifactRef: string | null

  /** Discard the provisional temp (no-op when null). */
  discard(): void

  /** Phase A: activate the artifact (no-clobber, ownership-aware). */
  activateArtifact(): void

  /** Phase C2: revalidate the published artifact (regular file, size, digest). */
  validateArtifact(): void

  /** Roll back owned outputs (temps only) and report any cleanup failure. */
  rollback(): string[]

  /** Build the final response — only after the whole transaction commits. */
  buildResponse(): OperationResponse
}

function runFallbackOperation(
  op: BatchOperation,
  cwd: string | undefined,
  budget: number,
  artifactBase: string | undefined,
  probe: BatchStateProbe | null,
):
  | { kind: "final"; resp: OperationResponse; used: number }
  | { kind: "pending"; pending: PendingFallbackActivation } {
  // The whole-batch preflight in executeBatchFallback has already validated
  // that this op is a known, read-only, batchable operation; the descriptor
  // is only consulted here for its output bound.
  const descriptor = tsToolDescriptor(op.op)!
  const effectiveLimit = Math.min(descriptor.maximumOutputBytes, Math.max(0, budget))
  const outcome = runOp(op.op, op.params, cwd)
  if (!outcome.ok) {
    return {
      kind: "final",
      resp: { id: op.id, ok: false, error: { code: outcome.code, message: outcome.message } },
      used: 0,
    }
  }

  // Post-execution state revalidation: a mid-batch mutation that occurred
  // while the operation was running must invalidate the result. Discard the
  // result, mark the batch stale, and return E_STALE_SNAPSHOT.
  if (probe !== null && !probe.stateUnchanged()) {
    return {
      kind: "final",
      resp: {
        id: op.id,
        ok: false,
        error: {
          code: E_STALE_SNAPSHOT,
          message: "operation result discarded: repository state changed during execution",
        },
      },
      used: 0,
    }
  }

  // Per-op final barrier (fast abort): one more state check before the result
  // is staged as a pending activation. The authoritative commit decision still
  // happens at the batch fence.
  if (probe !== null && !probe.stateUnchanged()) {
    return {
      kind: "final",
      resp: {
        id: op.id,
        ok: false,
        error: {
          code: E_STALE_SNAPSHOT,
          message: "operation result discarded: repository state changed during execution",
        },
      },
      used: 0,
    }
  }

  // Stage the provisional result: serialize, prepare the artifact temp
  // (write-exact + fsync), but DO NOT publish yet. Preparation failure
  // (conflict/corruption/permission) fails the op closed.
  return prepareFallbackResponse(op.id, outcome.value, effectiveLimit, artifactBase)
}

/**
 * Stage a provisional fallback response without publishing anything. When the
 * payload exceeds `limit`, a provisional artifact temp is written (exclusive,
 * write-exact, fsynced) but NOT renamed. The caller commits or discards it at
 * the batch fence.
 */
function prepareFallbackResponse(
  id: string,
  value: unknown,
  limit: number,
  artifactBase: string | undefined,
):
  | { kind: "pending"; pending: PendingFallbackActivation }
  | { kind: "final"; resp: OperationResponse; used: number } {
  let bytes: Buffer
  try {
    bytes = Buffer.from(JSON.stringify(value))
  } catch {
    return {
      kind: "final",
      resp: { id, ok: false, error: { code: E_INTERNAL, message: "failed to serialize operation result" } },
      used: 0,
    }
  }
  const used = bytes.length
  let artifact: ProvisionalArtifact | null = null
  let contentHash = ""
  if (used > limit) {
    const dir = artifactBase
      ? join(artifactBase, "artifacts")
      : join(tmpdir(), "fdx-batch-artifacts")
    contentHash = sha256Hex(bytes)
    const fileName = artifactFileName(id, contentHash)
    const finalPath = join(dir, fileName)
    try {
      artifact = prepareArtifact(finalPath, bytes, contentHash)
    } catch (e) {
      // Preparation failure (conflict, corruption, permission, I/O) fails
      // this op closed with a clear message — never an escaped throw.
      return {
        kind: "final",
        resp: {
          id,
          ok: false,
          error: { code: E_INTERNAL, message: `failed to write artifact: ${errorText(e)}` },
        },
        used,
      }
    }
  }
  return {
    kind: "pending",
    pending: {
      id,
      used,
      limit,
      bytes,
      contentHash,
      artifact,
      value,
      artifactRef: null,
      discard() {
        artifact?.discard()
      },
      activateArtifact() {
        if (artifact !== null && this.artifactRef === null) {
          const outcome = artifact.activate(bytes, contentHash)
          this.artifactRef = outcome.path
          // P1-4: published finals are content-addressed and IMMUTABLE —
          // rollback NEVER deletes them (another transaction may reuse them).
          // Only temp/staging files are disposed on rollback.
        }
      },
      validateArtifact() {
        if (this.artifactRef === null) return
        let valid = false
        try {
          const st = statSync(this.artifactRef)
          valid = st.isFile() && st.size === bytes.length && sha256Hex(readFileSync(this.artifactRef)) === contentHash
        } catch {
          valid = false
        }
        if (!valid) {
          throw new Error(`artifact ${this.artifactRef} no longer valid (missing, wrong size, or digest mismatch)`)
        }
      },
      rollback(): string[] {
        // Discard the provisional TEMP only; report any cleanup failure
        // (P2-5). Published finals survive (immutable, P1-4).
        const issues: string[] = []
        if (artifact !== null && artifact.tempPath !== artifact.finalPath) {
          try {
            unlinkSync(artifact.tempPath)
          } catch (e) {
            issues.push(`failed to remove provisional temp ${artifact.tempPath}: ${errorText(e)}`)
          }
        }
        return issues
      },
      buildResponse(): OperationResponse {
        if (used <= limit) {
          return { id, ok: true, result: value }
        }
        // Validation happened in Phase C2 BEFORE global success (P1-3); the
        // response is only built after all validations passed, so no
        // per-op failure can surface post-commit.
        const ref = this.artifactRef ?? ""
        return {
          id,
          ok: true,
          result: {
            truncated: true,
            artifactRef: ref,
            byteCount: used,
            limitBytes: limit,
            contentHash,
          },
          truncated: true,
          artifactRef: ref,
        }
      },
    },
  }
}

function runOp(op: string, params: OperationParams, cwd: string | undefined): OpResult {
  switch (op) {
    case "read":
      return opRead(params, cwd)
    case "grep":
      return opGrep(params, cwd)
    case "search":
      return opSearch(params, cwd)
    case "outline":
      return opOutline(params, cwd)
    case "impact":
      return opImpact(params, cwd)
    case "testsFor":
      return opTestsFor(params)
    default:
      return errResult(E_UNSUPPORTED, `unknown batch operation '${op}'`)
  }
}
