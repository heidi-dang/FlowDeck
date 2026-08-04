/**
 * Canonical release-version contract.
 *
 * The FlowDeck release version is defined once, in the root package.json
 * manifest. Production code, build scripts, and CI workflows must derive it
 * from that manifest rather than hardcoding it, so a version bump can never
 * silently drift across the runtime, the native FDX platform packages, and
 * the release workflows.
 *
 * Explicit test data (tests/) and generated package artifacts (packages/) are
 * exempt; crates/fdx/Cargo.toml is instead validated for alignment, because it
 * is the canonical source of the FDX binary version.
 */

import { describe, it, expect } from "bun:test"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const REPO_ROOT = join(import.meta.dir, "..")
const PACKAGE_JSON_PATH = join(REPO_ROOT, "package.json")
const CARGO_MANIFEST_PATH = join(REPO_ROOT, "crates", "fdx", "Cargo.toml")

/** Production directories that must never hardcode the release version. */
const SCANNED_DIRS = ["src", "scripts", ".github/workflows"]

/** Generated/non-text files that are exempt from the literal scan. */
const EXEMPT_FILE_SUFFIXES = [".map"]

function getCanonicalVersion(): string {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as { version?: unknown }
  if (typeof pkg.version !== "string" || pkg.version.length === 0) {
    throw new Error("root package.json is missing a valid version field")
  }
  return pkg.version
}

function collectFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      out.push(...collectFiles(full))
    } else if (st.isFile()) {
      out.push(full)
    }
  }
  return out
}

function isTextFile(file: string): boolean {
  return !readFileSync(file).includes(0)
}

describe("Canonical release version source", () => {
  it("root package.json declares the canonical release version", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf-8")) as { name?: string; version?: string }
    expect(pkg.name).toBe("@heidi-dang/flowdeck")
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/)
  })

  it("crates/fdx/Cargo.toml binary version is aligned with the release version", () => {
    const cargo = readFileSync(CARGO_MANIFEST_PATH, "utf-8")
    const packageSection = cargo.slice(cargo.indexOf("[package]"))
    const match = packageSection.match(/^version\s*=\s*"([^"]+)"/m)
    expect(match?.[1]).toBe(getCanonicalVersion())
  })

  it("no production source, script, or workflow hardcodes the release version", () => {
    const canonical = getCanonicalVersion()
    const escaped = canonical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    // Digit boundary: "1.0.4" matches, but "1.0.40" or "11.0.4" do not.
    const versionLiteral = new RegExp(`(?<![0-9])${escaped}(?![0-9])`)

    const violations: string[] = []
    for (const dir of SCANNED_DIRS) {
      const base = join(REPO_ROOT, dir)
      if (!existsSync(base)) continue
      for (const file of collectFiles(base)) {
        if (EXEMPT_FILE_SUFFIXES.some(suffix => file.endsWith(suffix))) continue
        if (!isTextFile(file)) continue
        const content = readFileSync(file, "utf-8")
        if (versionLiteral.test(content)) {
          violations.push(relative(REPO_ROOT, file))
        }
      }
    }
    expect(violations).toEqual([])
  })

  it("runtime version getter returns the canonical release version", async () => {
    const { getFlowdeckPackageVersion } = await import("../src/tools/fdx-shared.js")
    expect(getFlowdeckPackageVersion()).toBe(getCanonicalVersion())
  })

  it("FDX repair cache is versioned by the canonical release version", async () => {
    const { getFlowdeckPackageVersion, getFdxCacheDir, detectFdxTarget } = await import("../src/tools/fdx-shared.js")
    const target = detectFdxTarget()
    if (!target) return // host has no prebuilt FDX target — nothing to cache
    expect(getFdxCacheDir(target)).toContain(getFlowdeckPackageVersion())
  })
})
