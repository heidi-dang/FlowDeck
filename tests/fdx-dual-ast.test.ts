/**
 * FDX Dual-AST Integration Tests
 *
 * Verifies real native `fdx diff` execution against temporary Git repositories.
 * Tests modified signatures, body-only changes, symbol additions, deletions,
 * duplicate method names in separate scopes, TSX components, staged changes,
 * file renames, and invalid base refs.
 */

import { describe, it, expect } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { execFileSync } from "child_process"
import { resolveFdxBinaryPath } from "../src/tools/fdx"

function createTestRepo(): { repoDir: string; bin: string | null; cleanup: () => void } {
  const bin = resolveFdxBinaryPath() || join(__dirname, "../crates/fdx/target/debug/fdx")
  if (!existsSync(bin)) {
    return { repoDir: "", bin: null, cleanup: () => {} }
  }
  const repoDir = mkdtempSync(join(tmpdir(), "fdx-ast-test-"))
  execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" })
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir, stdio: "ignore" })
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" })

  const cleanup = () => {
    try {
      rmSync(repoDir, { recursive: true, force: true })
    } catch {}
  }
  return { repoDir, bin, cleanup }
}

describe("Real FDX Dual-AST Diff Integration", () => {
  it("detects signature modification vs body-only changes", () => {
    const { repoDir, bin, cleanup } = createTestRepo()
    if (!bin) return
    try {
      const file = join(repoDir, "service.ts")
      writeFileSync(file, `export function calculate(a: number): number {\n  return a * 2;\n}\n`)
      execFileSync("git", ["add", "."], { cwd: repoDir })
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir })

      // Signature modification
      writeFileSync(file, `export function calculate(a: number, b: number): number {\n  return a * b;\n}\n`)
      execFileSync("git", ["add", "."], { cwd: repoDir })
      execFileSync("git", ["commit", "-m", "sig-change"], { cwd: repoDir })

      const sigDiffRaw = execFileSync(bin, ["diff", "HEAD~1", "--format", "json"], {
        cwd: repoDir,
        env: { ...process.env, FDX_DISABLE_FALLBACK: "1" },
        encoding: "utf-8",
      })
      const sigDiff = JSON.parse(sigDiffRaw)
      expect(sigDiff.files.length).toBe(1)
      expect(sigDiff.files[0].path).toBe("service.ts")
      expect(sigDiff.files[0].status).toBe("modified")
      expect(sigDiff.files[0].symbol_changes[0].name).toBe("calculate")
      expect(sigDiff.files[0].symbol_changes[0].kind).toBe("function")
      expect(sigDiff.files[0].symbol_changes[0].change_type).toBe("signature_changed")
      expect(sigDiff.files[0].symbol_changes[0].line_start).toBe(1)

      // Body-only change
      writeFileSync(file, `export function calculate(a: number, b: number): number {\n  return a * b + 10;\n}\n`)
      execFileSync("git", ["add", "."], { cwd: repoDir })
      execFileSync("git", ["commit", "-m", "body-change"], { cwd: repoDir })

      const bodyDiffRaw = execFileSync(bin, ["diff", "HEAD~1", "--format", "json"], {
        cwd: repoDir,
        env: { ...process.env, FDX_DISABLE_FALLBACK: "1" },
        encoding: "utf-8",
      })
      const bodyDiff = JSON.parse(bodyDiffRaw)
      expect(bodyDiff.files[0].symbol_changes[0].name).toBe("calculate")
      expect(bodyDiff.files[0].symbol_changes[0].change_type).toBe("body_changed")
      expect(bodyDiff.files[0].symbol_changes[0].lines_added).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })

  it("handles symbol additions and deletions", () => {
    const { repoDir, bin, cleanup } = createTestRepo()
    if (!bin) return
    try {
      const file = join(repoDir, "service.ts")
      writeFileSync(file, `export class OldService {\n  oldMethod() { return 1; }\n}\n`)
      execFileSync("git", ["add", "."], { cwd: repoDir })
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir })

      writeFileSync(file, `export class NewService {\n  newMethod() { return 2; }\n}\n`)
      execFileSync("git", ["add", "."], { cwd: repoDir })
      execFileSync("git", ["commit", "-m", "replace-service"], { cwd: repoDir })

      const diffOutputRaw = execFileSync(bin, ["diff", "HEAD~1", "--format", "json"], {
        cwd: repoDir,
        env: { ...process.env, FDX_DISABLE_FALLBACK: "1" },
        encoding: "utf-8",
      })
      const diffOutput = JSON.parse(diffOutputRaw)
      expect(diffOutput.files[0].path).toBe("service.ts")
      const deletedSym = diffOutput.files[0].symbol_changes.find((s: any) => s.name === "OldService")
      const addedSym = diffOutput.files[0].symbol_changes.find((s: any) => s.name === "NewService")
      expect(deletedSym).toBeDefined()
      expect(deletedSym.change_type).toBe("deleted")
      expect(deletedSym.line_start).toBe(1) // Uses base-AST range
      expect(addedSym).toBeDefined()
      expect(addedSym.change_type).toBe("added")
    } finally {
      cleanup()
    }
  })

  it("distinguishes same method name in separate scopes", () => {
    const { repoDir, bin, cleanup } = createTestRepo()
    if (!bin) return
    try {
      const file = join(repoDir, "scope.ts")
      writeFileSync(
        file,
        `export class UserService {\n  save() { return "user"; }\n}\nexport class ProductService {\n  save() { return "product"; }\n}\n`
      )
      execFileSync("git", ["add", "."], { cwd: repoDir })
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir })

      writeFileSync(
        file,
        `export class UserService {\n  save() { return "user"; }\n}\nexport class ProductService {\n  save() { return "product-updated"; }\n}\n`
      )
      execFileSync("git", ["add", "."], { cwd: repoDir })
      execFileSync("git", ["commit", "-m", "update-product-save"], { cwd: repoDir })

      const diffOutputRaw = execFileSync(bin, ["diff", "HEAD~1", "--format", "json"], {
        cwd: repoDir,
        env: { ...process.env, FDX_DISABLE_FALLBACK: "1" },
        encoding: "utf-8",
      })
      const diffOutput = JSON.parse(diffOutputRaw)
      expect(diffOutput.files[0].symbol_changes.length).toBe(1)
      expect(diffOutput.files[0].symbol_changes[0].name).toBe("save")
      expect(diffOutput.files[0].symbol_changes[0].kind).toBe("method")
      expect(diffOutput.files[0].symbol_changes[0].change_type).toBe("body_changed")
    } finally {
      cleanup()
    }
  })

  it("handles TSX component changes", () => {
    const { repoDir, bin, cleanup } = createTestRepo()
    if (!bin) return
    try {
      const file = join(repoDir, "UserCard.tsx")
      writeFileSync(file, `export function UserCard(props: { name: string }) {\n  return <div>{props.name}</div>;\n}\n`)
      execFileSync("git", ["add", "."], { cwd: repoDir })
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir })

      writeFileSync(
        file,
        `export function UserCard(props: { name: string; age: number }) {\n  return <div>{props.name} ({props.age})</div>;\n}\n`
      )
      execFileSync("git", ["add", "."], { cwd: repoDir })
      execFileSync("git", ["commit", "-m", "update-user-card"], { cwd: repoDir })

      const diffOutputRaw = execFileSync(bin, ["diff", "HEAD~1", "--format", "json"], {
        cwd: repoDir,
        env: { ...process.env, FDX_DISABLE_FALLBACK: "1" },
        encoding: "utf-8",
      })
      const diffOutput = JSON.parse(diffOutputRaw)
      expect(diffOutput.files[0].path).toBe("UserCard.tsx")
      expect(diffOutput.files[0].symbol_changes[0].name).toBe("UserCard")
      expect(diffOutput.files[0].symbol_changes[0].change_type).toBe("signature_changed")
    } finally {
      cleanup()
    }
  })

  it("handles staged changes via --staged flag", () => {
    const { repoDir, bin, cleanup } = createTestRepo()
    if (!bin) return
    try {
      const file = join(repoDir, "staged.ts")
      writeFileSync(file, `export function run() { return 1; }\n`)
      execFileSync("git", ["add", "."], { cwd: repoDir })
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir })

      writeFileSync(file, `export function run() { return 2; }\n`)
      execFileSync("git", ["add", "."], { cwd: repoDir })

      const diffOutputRaw = execFileSync(bin, ["diff", "--staged", "--format", "json"], {
        cwd: repoDir,
        env: { ...process.env, FDX_DISABLE_FALLBACK: "1" },
        encoding: "utf-8",
      })
      const diffOutput = JSON.parse(diffOutputRaw)
      expect(diffOutput.staged).toBe(true)
      expect(diffOutput.files[0].path).toBe("staged.ts")
      expect(diffOutput.files[0].symbol_changes[0].name).toBe("run")
      expect(diffOutput.files[0].symbol_changes[0].change_type).toBe("body_changed")
    } finally {
      cleanup()
    }
  })

  it("handles renamed files cleanly", () => {
    const { repoDir, bin, cleanup } = createTestRepo()
    if (!bin) return
    try {
      const oldFile = join(repoDir, "oldName.ts")
      writeFileSync(oldFile, `export function shared() { return true; }\n`)
      execFileSync("git", ["add", "."], { cwd: repoDir })
      execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir })

      execFileSync("git", ["mv", "oldName.ts", "newName.ts"], { cwd: repoDir })
      execFileSync("git", ["commit", "-m", "rename"], { cwd: repoDir })

      const diffOutputRaw = execFileSync(bin, ["diff", "HEAD~1", "--format", "json"], {
        cwd: repoDir,
        env: { ...process.env, FDX_DISABLE_FALLBACK: "1" },
        encoding: "utf-8",
      })
      const diffOutput = JSON.parse(diffOutputRaw)
      expect(diffOutput.files.length).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })

  it("surfaces clean error for invalid base refs", () => {
    const { repoDir, bin, cleanup } = createTestRepo()
    if (!bin) return
    try {
      let threw = false
      try {
        execFileSync(bin, ["diff", "non_existent_commit_12345"], {
          cwd: repoDir,
          env: { ...process.env, FDX_DISABLE_FALLBACK: "1" },
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        })
      } catch (err: any) {
        threw = true
        expect(err.stderr || err.stdout || err.message).toContain("invalid")
      }
      expect(threw).toBe(true)
    } finally {
      cleanup()
    }
  })
})
