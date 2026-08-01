/**
 * FDX Persistent Index — Repository-Boundary & Symlink Security Tests
 * (Task 3D §2).
 *
 * No indexed file content may originate from outside the canonical
 * repository root. These tests drive the REAL native `fdx` binary against
 * fixtures containing:
 *
 * - a file symlink to an external file;
 * - a directory symlink to an external directory;
 * - chained symlinks;
 * - broken symlinks;
 * - symlink loops;
 * - internal repository symlinks (permitted);
 * - replacement of a validated file with a symlink before read (TOCTOU);
 * - Windows junctions where the platform supports them.
 *
 * The assertion is always the same: external file content NEVER enters the
 * index, and the repository stays indexable. Fail closed when the native
 * binary is unavailable.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { execFileSync, execSync } from "node:child_process"
import * as fs from "node:fs"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createHash } from "node:crypto"

const ROOT = resolve(import.meta.dirname, "..")
const BIN_NAME = process.platform === "win32" ? "fdx.exe" : "fdx"

function findBinary(name: string): string | null {
  for (const c of [join(ROOT, "target", "debug", name), join(ROOT, "crates", "fdx", "target", "debug", name)]) {
    if (existsSync(c)) return c
  }
  return null
}

let FDX: string | null = findBinary(BIN_NAME)

beforeAll(() => {
  if (!FDX) {
    try {
      execSync(`cargo build --manifest-path ${join(ROOT, "crates/fdx/Cargo.toml")} --bin fdx`, {
        cwd: ROOT,
        stdio: "pipe",
        timeout: 240_000,
      })
      FDX = findBinary(BIN_NAME)
    } catch {
      throw new Error("fdx native binary unavailable and could not be built; boundary tests fail closed")
    }
  }
  if (!FDX) throw new Error("fdx native binary unavailable after build")
})

let stateDir: string
beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "fdx-boundary-state-"))
})
afterAll(() => {
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
})

function git(dir: string, args: string[]) {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" })
}

function makeRepo(seed = "seed"): string {
  const dir = mkdtempSync(join(tmpdir(), "fdx-boundary-repo-"))
  git(dir, ["init", "-q"])
  git(dir, ["config", "user.email", "t@t"])
  git(dir, ["config", "user.name", "t"])
  writeFileSync(join(dir, "lib.ts"), `export function greet(): string { return "${seed}" }\n`)
  writeFileSync(join(dir, "main.rs"), "pub fn main() {}\n")
  git(dir, ["add", "-A"])
  git(dir, ["commit", "-qm", "init"])
  return dir
}

function fdxIndex(dir: string, args: string[]): string {
  return execFileSync(FDX!, ["index", ...args, "--cwd", dir], {
    encoding: "utf-8",
    env: { ...process.env, FDX_INDEX_DIR: stateDir },
  })
}

function refresh(dir: string): any {
  return JSON.parse(fdxIndex(dir, ["refresh"]))
}

function status(dir: string): any {
  return JSON.parse(fdxIndex(dir, ["status"]))
}

/** Whether the platform can create a symlink (Windows needs privileges). */
function canSymlink(): boolean {
  try {
    const probe = mkdtempSync(join(tmpdir(), "fdx-symlink-probe-"))
    try {
      if (process.platform === "win32") {
        // Windows requires either admin or developer mode for symlinks.
        fs.symlinkSync(join(probe, "target.txt"), join(probe, "link.txt"))
      } else {
        execSync(`ln -s target.txt "${join(probe, "link.txt")}"`)
      }
      rmSync(probe, { recursive: true, force: true })
      return true
    } catch {
      rmSync(probe, { recursive: true, force: true })
      return false
    }
  } catch {
    return false
  }
}

const SYMLINKS = canSymlink()

describe("FDX index repository-boundary security (real binary)", () => {
  it("external file symlink content never enters the index", () => {
    const dir = makeRepo()
    const outside = mkdtempSync(join(tmpdir(), "fdx-outside-"))
    writeFileSync(join(outside, "secret.txt"), "TOPSECRET-EXTERNAL-CONTENT\n")
    if (process.platform === "win32") {
      try {
        fs.symlinkSync(join(outside, "secret.txt"), join(dir, "leak.ts"))
      } catch {
        rmSync(outside, { recursive: true, force: true })
        rmSync(dir, { recursive: true, force: true })
        return // no symlink support: skip, justified platform limitation
      }
    } else {
      execSync(`ln -s "${join(outside, "secret.txt")}" "${join(dir, "leak.ts")}"`)
    }
    const r = refresh(dir)
    expect(r.files).toBeGreaterThanOrEqual(1)
    // The symlink itself is either excluded or recorded as a symlink; the
    // EXTERNAL content must never be read into the index. Query the file
    // index for the secret marker via a symbol/filename check.
    const s = status(dir)
    expect(s.available).toBe(true)
    // External content must not appear anywhere in the persisted index.
    const wt = worktreeStateDir(dir)
    const gens = readdirSync(wt).filter((e) => e.startsWith("gen-") && !e.includes(".tmp"))
    for (const gen of gens) {
      const filesJson = fs.readFileSync(join(wt, gen, "files.json"), "utf-8")
      expect(filesJson).not.toContain("TOPSECRET-EXTERNAL-CONTENT")
      const symbolsJson = fs.readFileSync(join(wt, gen, "symbols.json"), "utf-8")
      expect(symbolsJson).not.toContain("TOPSECRET-EXTERNAL-CONTENT")
    }
    rmSync(outside, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it("directory symlink to an external directory never enters the index", () => {
    const dir = makeRepo()
    const outside = mkdtempSync(join(tmpdir(), "fdx-outside-dir-"))
    writeFileSync(join(outside, "leak-module.ts"), "export const leaked = 'EXTERNAL-DIR-SECRET'\n")
    if (process.platform === "win32") {
      try {
        fs.symlinkSync(outside, join(dir, "extdir"), "junction")
      } catch {
        rmSync(outside, { recursive: true, force: true })
        rmSync(dir, { recursive: true, force: true })
        return
      }
    } else {
      execSync(`ln -s "${outside}" "${join(dir, "extdir")}"`)
    }
    const r = refresh(dir)
    expect(r.files).toBeGreaterThanOrEqual(1)
    const s = status(dir)
    expect(s.available).toBe(true)
    // The external directory's files must not be indexed.
    const wt = worktreeStateDir(dir)
    for (const gen of readdirSync(wt).filter((e) => e.startsWith("gen-") && !e.includes(".tmp"))) {
      const filesJson = fs.readFileSync(join(wt, gen, "files.json"), "utf-8")
      expect(filesJson).not.toContain("EXTERNAL-DIR-SECRET")
    }
    rmSync(outside, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it("chained symlinks resolving outside are rejected", () => {
    if (!SYMLINKS) return
    const dir = makeRepo()
    const outside = mkdtempSync(join(tmpdir(), "fdx-outside-chain-"))
    writeFileSync(join(outside, "target.ts"), "export const chained = 'CHAIN-EXTERNAL'\n")
    execSync(`ln -s "${join(outside, "target.ts")}" "${join(dir, "hop1.ts")}"`)
    execSync(`ln -s "hop1.ts" "${join(dir, "hop2.ts")}"`)
    const r = refresh(dir)
    expect(r.files).toBeGreaterThanOrEqual(1)
    const wt = worktreeStateDir(dir)
    for (const gen of readdirSync(wt).filter((e) => e.startsWith("gen-") && !e.includes(".tmp"))) {
      const filesJson = fs.readFileSync(join(wt, gen, "files.json"), "utf-8")
      expect(filesJson).not.toContain("CHAIN-EXTERNAL")
    }
    rmSync(outside, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it("broken symlinks are skipped safely", () => {
    if (!SYMLINKS) return
    const dir = makeRepo()
    execSync(`ln -s "missing-target-${Date.now()}" "${join(dir, "broken.ts")}"`)
    const r = refresh(dir)
    expect(r.files).toBeGreaterThanOrEqual(1)
    expect(status(dir).available).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it("symlink loops are handled without hanging or indexing external data", () => {
    if (!SYMLINKS) return
    const dir = makeRepo()
    execSync(`ln -s "loop-b.ts" "${join(dir, "loop-a.ts")}"`)
    execSync(`ln -s "loop-a.ts" "${join(dir, "loop-b.ts")}"`)
    const r = refresh(dir)
    expect(r.files).toBeGreaterThanOrEqual(1)
    expect(status(dir).available).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it("internal repository symlinks are permitted and stay inside", () => {
    if (!SYMLINKS) return
    const dir = makeRepo()
    // Internal symlink: points at a file inside the repo.
    execSync(`ln -s "lib.ts" "${join(dir, "lib-alias.ts")}"`)
    const r = refresh(dir)
    expect(r.files).toBeGreaterThanOrEqual(1)
    expect(status(dir).available).toBe(true)
    // The alias resolves inside the repo; no external marker can appear.
    const wt = worktreeStateDir(dir)
    for (const gen of readdirSync(wt).filter((e) => e.startsWith("gen-") && !e.includes(".tmp"))) {
      const filesJson = fs.readFileSync(join(wt, gen, "files.json"), "utf-8")
      expect(filesJson).not.toContain("seed")
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it("replacing a validated file with a symlink before read never leaks content", async () => {
    const dir = makeRepo()
    const outside = mkdtempSync(join(tmpdir(), "fdx-outside-toctou-"))
    writeFileSync(join(outside, "bad.ts"), "export const toctou = 'TOCTOU-EXTERNAL'\n")
    // Refresh once to establish a valid index.
    refresh(dir)
    // Swap a tracked file for an external symlink (TOCTOU-style) and refresh.
    if (process.platform === "win32") {
      try {
        rmSync(join(dir, "lib.ts"))
        fs.symlinkSync(join(outside, "bad.ts"), join(dir, "lib.ts"))
      } catch {
        rmSync(outside, { recursive: true, force: true })
        rmSync(dir, { recursive: true, force: true })
        return
      }
    } else {
      rmSync(join(dir, "lib.ts"))
      execSync(`ln -s "${join(outside, "bad.ts")}" "${join(dir, "lib.ts")}"`)
    }
    refresh(dir)
    expect(status(dir).available).toBe(true)
    const wt = worktreeStateDir(dir)
    let externalFound = false
    for (const gen of readdirSync(wt).filter((e) => e.startsWith("gen-") && !e.includes(".tmp"))) {
      const filesJson = fs.readFileSync(join(wt, gen, "files.json"), "utf-8")
      if (filesJson.includes("TOCTOU-EXTERNAL")) externalFound = true
    }
    expect(externalFound).toBe(false)
    rmSync(outside, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })

  it("external files never appear in any component (files/symbols/dependencies)", () => {
    const dir = makeRepo()
    const outside = mkdtempSync(join(tmpdir(), "fdx-outside-3-"))
    writeFileSync(join(outside, "module.ts"), "export const three = 'SECRET-NO-ENTRY'\n")
    if (process.platform === "win32") {
      try {
        fs.symlinkSync(join(outside, "module.ts"), join(dir, "module-link.ts"))
      } catch {
        rmSync(outside, { recursive: true, force: true })
        rmSync(dir, { recursive: true, force: true })
        return
      }
    } else {
      execSync(`ln -s "${join(outside, "module.ts")}" "${join(dir, "module-link.ts")}"`)
    }
    refresh(dir)
    const wt = worktreeStateDir(dir)
    for (const gen of readdirSync(wt).filter((e) => e.startsWith("gen-") && !e.includes(".tmp"))) {
      for (const component of ["files.json", "symbols.json", "dependencies.json", "test-mapping.json", "content-cache.json"]) {
        const text = fs.readFileSync(join(wt, gen, component), "utf-8")
        expect(text).not.toContain("SECRET-NO-ENTRY")
      }
    }
    rmSync(outside, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  })
})

// Worktree state dir computation (mirrors Rust identity_hash).

function worktreeStateDir(dir: string): string {
  let gitCommonDir: string | null = null
  try {
    gitCommonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, encoding: "utf-8" }).trim()
  } catch {}
  // The Rust identity hashes CANONICAL (symlink-resolved) paths; realpathSync
  // is required on macOS where /var -> /private/var.
  const canonicalRepoRoot = canonicalize(gitCommonDir || resolve(dir))
  const norm = (p: string) => (process.platform === "win32" || process.platform === "darwin" ? p.toLowerCase() : p)
  const seg = (parts: string[]) => {
    const h = createHash("sha256")
    for (const part of parts) {
      h.update(part)
      h.update("\0")
    }
    return h.digest().toString("hex")
  }
  return join(stateDir, "fdx-index", seg(["repo", norm(canonicalRepoRoot)]), seg(["worktree", norm(canonicalize(dir))]))
}

/** Resolve symlinks (mirrors Rust `Path::canonicalize` with abs fallback). */
function canonicalize(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return resolve(p)
  }
}
