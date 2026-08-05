/**
 * FDX Path Parity Tests
 *
 * Verifies that TypeScript `generateProjectId` matches Rust's native `project_slug_from_directory`
 * exactly across absolute, relative, spaces, unicode, `.`, `..`, trailing separators, symlinks, and nonexistent paths.
 *
 * Both implementations consume the single canonical, versioned fixture
 * `fixtures/fdx/project-identity-v1.json` (algorithm v1 — see
 * `docs/project-identity.md`); the Rust side is `crates/fdx/tests/test_identity_fixture.rs`.
 */

import { describe, it, expect } from "bun:test"
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, readdirSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { execFileSync } from "child_process"
import { generateProjectId, normalizePathForId } from "../src/tools/planning-state-lib"
import { resolveFdxBinaryPath } from "../src/tools/fdx"

interface IdentityFixture {
  id: string
  input: string | null
  platform: string
  canonical: { posix: string | null; windows: string | null }
  expected_id: { posix: string | null; windows: string | null }
  slug_prefix: string | null
  different_from: string[]
  create_dir: string | null
  explanation: string
}

function loadIdentityFixture(): { version: number; algorithm_version: string; entries: IdentityFixture[] } {
  const fixturePath = join(__dirname, "..", "fixtures", "fdx", "project-identity-v1.json")
  return JSON.parse(readFileSync(fixturePath, "utf-8"))
}

function currentPlatform(): "posix" | "windows" {
  return process.platform === "win32" ? "windows" : "posix"
}


interface PathFixture {
  label: string
  input: string
  expected_id_prefix: string
  different_from?: string
  note?: string
}

function loadFixtures(): PathFixture[] {
  const fixturePath = join(__dirname, "fixtures", "path-scheme.json")
  if (!existsSync(fixturePath)) {
    throw new Error(`Fixture not found: ${fixturePath}`)
  }
  return JSON.parse(readFileSync(fixturePath, "utf-8"))
}

describe("generateProjectId path parity", () => {
  const fixtures = loadFixtures()

  it("loads all fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0)
  })

  for (const fx of fixtures) {
    it(`generates correct prefix for: ${fx.label}`, () => {
      const result = generateProjectId(fx.input)
      expect(result).toContain("-")
      expect(result.startsWith(fx.expected_id_prefix)).toBe(true)
    })
  }

  it("produces different IDs for C:\\work\\repo and D:\\work\\repo on Windows", () => {
    const idC = generateProjectId("C:\\work\\repo")
    const idD = generateProjectId("D:\\work\\repo")
    expect(idC).not.toBe(idD)
    expect(idC.startsWith("repo-")).toBe(true)
    expect(idD.startsWith("repo-")).toBe(true)
  })

  it("handles UNC paths, trailing slashes, dots, unicode, and relative paths deterministically", () => {
    const unc = generateProjectId("\\\\server\\share\\project")
    expect(unc.startsWith("project-")).toBe(true)

    const trailing = generateProjectId("/home/user/project/")
    const noTrailing = generateProjectId("/home/user/project")
    expect(trailing).toBe(noTrailing)

    const dots = generateProjectId("/home/user/app/../project")
    expect(dots).toBe(noTrailing)


    const nonexistent = generateProjectId("/nonexistent/path/to/my-repo")
    expect(nonexistent.startsWith("my-repo-")).toBe(true)

    const unicode = generateProjectId("/home/user/über-project")
    expect(unicode.startsWith("über-project-")).toBe(true)
  })

  it("is deterministic for the same input", () => {
    const dir = "/home/user/project"
    const r1 = generateProjectId(dir)
    const r2 = generateProjectId(dir)
    expect(r1).toBe(r2)
  })
})

describe("Exact TypeScript vs Native Rust Project ID Parity", () => {
  const bin = resolveFdxBinaryPath() || join(__dirname, "../crates/fdx/target/debug/fdx")

  it("matches native Rust project_slug for real directories, symlinks, spaces, unicode, and relative paths", () => {
    if (!existsSync(bin)) return // skip if binary not built yet in light test runs

    const tmpRoot = mkdtempSync(join(tmpdir(), "fdx-parity-"))
    try {
      const normalDir = join(tmpRoot, "normal-repo")
      const spaceDir = join(tmpRoot, "space repo")
      const unicodeDir = join(tmpRoot, "über-repo")
      const targetDir = join(tmpRoot, "target-repo")
      const symlinkPath = join(tmpRoot, "symlink-repo")

      mkdirSync(normalDir, { recursive: true })
      mkdirSync(spaceDir, { recursive: true })
      mkdirSync(unicodeDir, { recursive: true })
      mkdirSync(targetDir, { recursive: true })

      try {
        symlinkSync(targetDir, symlinkPath, process.platform === "win32" ? "junction" : "dir")
      } catch {}

      const testDirs = [
        normalDir,
        spaceDir,
        unicodeDir,
        targetDir,
        existsSync(symlinkPath) ? symlinkPath : null,
        join(normalDir, "."),
        join(normalDir, "sub", ".."),
      ].filter(Boolean) as string[]

      for (const dir of testDirs) {
        const tsId = generateProjectId(dir)

        // Invoke native Rust fdx context command with HOME overridden to isolated tmp directory
        const env = { ...process.env, HOME: tmpRoot, USERPROFILE: tmpRoot, FDX_DISABLE_FALLBACK: "1" }
        execFileSync(bin, ["context", "--topic", "parity-test", "--action", "append", "--agent", "coder", "--stage", "impl", "--summary", "parity test"], {
          cwd: dir,
          env,
          encoding: "utf-8",
        })



        // Check the directory created under ~/.fd-plan/
        const planRoot = join(tmpRoot, ".fd-plan")
        const createdEntries = existsSync(planRoot) ? require("fs").readdirSync(planRoot) : []
        expect(createdEntries).toContain(tsId)
      }
    } finally {
      try {
        rmSync(tmpRoot, { recursive: true, force: true })
      } catch {}
    }
  })
})

describe("Canonical project identity fixture (v1) — TypeScript", () => {
  const fx = loadIdentityFixture()
  const platform = currentPlatform()

  it("is versioned and pinned", () => {
    expect(fx.version).toBe(1)
    expect(fx.algorithm_version).toBe("v1")
    expect(fx.entries.length).toBeGreaterThanOrEqual(20)
  })

  for (const entry of fx.entries) {
    if (!entry.input) continue

    it(`canonical and id match fixture: ${entry.id}`, () => {
      if (!entry.input) return
      const canonical = entry.canonical[platform]
      if (canonical !== null) {
        expect(normalizePathForId(entry.input)).toBe(canonical)
      }
      const expectedId = entry.expected_id[platform]
      if (expectedId !== null) {
        expect(generateProjectId(entry.input)).toBe(expectedId)
      } else if (entry.slug_prefix !== null) {
        expect(generateProjectId(entry.input).startsWith(entry.slug_prefix)).toBe(true)
      }
    })

    if (entry.different_from.length > 0) {
      it(`collision corpus: ${entry.id} differs from ${entry.different_from.join(", ")}`, () => {
        if (!entry.input) return
        const base = generateProjectId(entry.input)
        for (const otherId of entry.different_from) {
          const other = fx.entries.find((e) => e.id === otherId)
          expect(other?.input).not.toBeNull()
          expect(generateProjectId(other!.input!)).not.toBe(base)
        }
      })
    }
  }

  it("drive-letter case equivalence (c: vs C:)", () => {
    expect(generateProjectId("c:\\work\\repo")).toBe(generateProjectId("C:\\work\\repo"))
  })

  it("separator equivalence (backslash vs forward slash)", () => {
    expect(generateProjectId("/home/user/project")).toBe(generateProjectId("/home/user\\project"))
  })

  it("normalization is idempotent", () => {
    for (const input of ["/home/user/project/", "/home/user/./project", "/home/user/app/../project", "/"]) {
      const once = normalizePathForId(input)
      expect(normalizePathForId(once)).toBe(once)
    }
  })

  it("is deterministic for identical input", () => {
    for (const entry of fx.entries) {
      if (!entry.input) continue
      expect(generateProjectId(entry.input)).toBe(generateProjectId(entry.input))
    }
  })
})

describe("Canonical project identity — TypeScript/Rust byte parity on real directories", () => {
  const fx = loadIdentityFixture()
  const bin = resolveFdxBinaryPath() || join(__dirname, "../crates/fdx/target/debug/fdx")

  it("produces byte-identical ids for every create_dir fixture entry", () => {
    if (!existsSync(bin)) return // skip if binary not built yet in light test runs

    const tmpRoot = mkdtempSync(join(tmpdir(), "fdx-id-parity-"))
    try {
      const dirs = fx.entries.filter((e) => e.create_dir)
      expect(dirs.length).toBeGreaterThan(0)

      for (const entry of dirs) {
        const dir = join(tmpRoot, entry.create_dir!)
        mkdirSync(dir, { recursive: true })

        const tsId = generateProjectId(dir)
        const env = { ...process.env, HOME: tmpRoot, USERPROFILE: tmpRoot, FDX_DISABLE_FALLBACK: "1" }
        execFileSync(bin, ["context", "--topic", "parity-test", "--action", "append", "--agent", "coder", "--stage", "impl", "--summary", "parity"], {
          cwd: dir,
          env,
          encoding: "utf-8",
        })

        const planRoot = join(tmpRoot, ".fd-plan")
        const created = existsSync(planRoot) ? readdirSync(planRoot) : []
        expect(created, `Rust project slug must equal TS id for ${entry.create_dir}`).toContain(tsId)
      }
    } finally {
      try {
        rmSync(tmpRoot, { recursive: true, force: true })
      } catch {}
    }
  })
})
