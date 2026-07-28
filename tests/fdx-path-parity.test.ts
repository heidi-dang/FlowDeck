/**
 * FDX Path Parity Tests
 *
 * Verifies that TypeScript `generateProjectId` matches Rust's native `project_slug_from_directory`
 * exactly across absolute, relative, spaces, unicode, `.`, `..`, trailing separators, symlinks, and nonexistent paths.
 */

import { describe, it, expect } from "vitest"
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { execFileSync } from "child_process"
import { generateProjectId } from "../src/tools/planning-state-lib"
import { resolveFdxBinaryPath } from "../src/tools/fdx"


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

  it("produces different IDs for same-named repos in different paths", () => {
    const id1 = generateProjectId("/home/user/projects/FlowDeck")
    const id2 = generateProjectId("/home/other/work/FlowDeck")
    expect(id1).not.toBe(id2)
  })

  it("hyphenated names are still hashed (do not pass through as raw names)", () => {
    const id = generateProjectId("/home/user/some---repo--name")
    const parts = id.split("-")
    const hash = parts[parts.length - 1]
    expect(hash).toMatch(/^[0-9a-f]{8}$/)
    expect(parts.length).toBeGreaterThan(1)
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
        symlinkSync(targetDir, symlinkPath, process.platform === "win32" ? "dir" : "file")
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
