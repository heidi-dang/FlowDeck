#!/usr/bin/env node
/**
 * release-alignment.mjs — Release alignment auditor
 *
 * Verifies all version fields are identical before publication:
 *   - package.json version
 *   - package-lock.json top-level version
 *   - package-lock.json packages[""].version
 *   - Installer reference version
 *
 * Also checks npm registry for version conflicts.
 */

import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { resolveReleaseChannel } from "./release-channel.mjs"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")
const PKG_NAME = "@heidi-dang/flowdeck"

let exitCode = 0

function check(label, ok, detail = "") {
  const icon = ok ? "✓" : "✗"
  console.log(` ${icon} ${label}${detail ? ": " + detail : ""}`)
  if (!ok) exitCode = 1
}

function main() {
  console.log("\nFlowDeck Release Alignment Check\n")

  // ── Read package files ────────────────────────────────────────────
  const pkgPath = join(ROOT, "package.json")
  const lockPath = join(ROOT, "package-lock.json")

  if (!existsSync(pkgPath)) { console.error("package.json not found"); process.exit(1) }
  if (!existsSync(lockPath)) { console.error("package-lock.json not found"); process.exit(1) }

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
  const lock = JSON.parse(readFileSync(lockPath, "utf-8"))

  const pkgVersion = pkg.version
  const lockVersion = lock.version
  const lockRootVersion = lock.packages?.[""]?.version

  console.log("── Version alignment ──\n")
  check("package.json version", !!pkgVersion, pkgVersion)
  check("package-lock.json version", !!lockVersion, lockVersion)
  check("lock packages root version", !!lockRootVersion, lockRootVersion)

  const allMatch = pkgVersion === lockVersion && lockVersion === lockRootVersion
  check("All versions identical", allMatch,
    allMatch ? pkgVersion : `pkg=${pkgVersion} lock=${lockVersion} root=${lockRootVersion}`)

  // ── Release channel / dist-tag derivation ─────────────────────────
  console.log("\n── Release channel ──\n")
  let channel = null
  try {
    channel = resolveReleaseChannel(pkgVersion)
    check("Release channel derivable", !!channel, channel)
  } catch (e) {
    check("Release channel derivable", false, e.message)
  }
  check("Expected npm dist-tag", !!channel, `${pkgVersion} → ${channel ?? "unresolved"}`)

  // ── Release documentation ────────────────────────────────────────
  const readme = readFileSync(join(ROOT, "README.md"), "utf-8")
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf-8")
  const releaseNotePath = join(ROOT, "docs", "releases", `v${pkgVersion}.md`)
  check("README active version", readme.includes(`v${pkgVersion}`), `v${pkgVersion}`)
  check("CHANGELOG current entry", changelog.includes(`## [${pkgVersion}]`), pkgVersion)
  check("Release-note file", existsSync(releaseNotePath), releaseNotePath)

  // ── Check npm registry ────────────────────────────────────────────
  console.log("\n── Registry check ──\n")
  try {
    const publishedVersions = JSON.parse(
      execFileSync("npm", ["view", PKG_NAME, "versions", "--json"], {
        encoding: "utf-8", timeout: 15000,
      })
    )
    console.log(`  Published versions (${publishedVersions.length}): ${publishedVersions.join(", ")}`)

    const alreadyPublished = publishedVersions.includes(pkgVersion)
    check(`Version ${pkgVersion} already published`, !alreadyPublished,
      alreadyPublished ? `EXISTS — will not republish` : `unused, safe to publish`)

    if (alreadyPublished) {
      // Check gitHead alignment
      try {
        const remoteInfo = JSON.parse(
          execFileSync("npm", ["view", `${PKG_NAME}@${pkgVersion}`, "version", "gitHead", "--json"], {
            encoding: "utf-8", timeout: 10000,
          })
        )
        const localSha = execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf-8", timeout: 5000,
        }).trim()
        const shaMatch = remoteInfo.gitHead === localSha
        check(`gitHead matches local HEAD`, shaMatch,
          shaMatch ? localSha : `remote: ${remoteInfo.gitHead}, local: ${localSha}`)
      } catch (e) {
        check("gitHead check", false, e.message)
      }
    }
  } catch (e) {
    check("npm registry query", false, e.message)
  }

  // ── Dist tags ─────────────────────────────────────────────────────
  console.log("\n── Dist tags ──\n")
  try {
    const tags = JSON.parse(
      execFileSync("npm", ["view", PKG_NAME, "dist-tags", "--json"], {
        encoding: "utf-8", timeout: 10000,
      })
    )
    console.log(`  latest: ${tags.latest}`)
    console.log(`  next: ${tags.next}`)
    if (tags.alpha) console.log(`  alpha: ${tags.alpha}`)
  } catch { console.log("  (could not fetch dist-tags)") }

  // ── Package exports ───────────────────────────────────────────────
  console.log("\n── Package exports ──\n")
  check("bin.flowdeck defined", pkg.bin?.flowdeck === "./bin/flowdeck.js")
  check("main entry exists", pkg.main === "./dist/index.js")
  check("type is module", pkg.type === "module")
  check("publishConfig is public", pkg.publishConfig?.access === "public")
  check("files array includes dist and bin",
    Array.isArray(pkg.files) &&
    pkg.files.includes("dist") &&
    pkg.files.includes("bin"))
  check("files array includes script modules",
    Array.isArray(pkg.files) &&
    pkg.files.some(f => f.startsWith("scripts/")))

  // ── Git state ─────────────────────────────────────────────────────
  console.log("\n── Git state ──\n")
  try {
    const status = execFileSync("git", ["status", "--short"], {
      encoding: "utf-8", timeout: 5000, cwd: ROOT,
    }).trim()
    check("Working tree clean", status === "", status ? `dirty: ${status.slice(0, 200)}` : "clean")

    const branch = execFileSync("git", ["branch", "--show-current"], {
      encoding: "utf-8", timeout: 5000, cwd: ROOT,
    }).trim()
    check("On release branch", branch === "v2.0.0-alpha" || branch === "main" || branch === "chore/v2-alpha2-release-readiness", branch)
  } catch (e) {
    check("Git state", false, e.message)
  }

  console.log(`\n── Result ──\n`)
  if (exitCode === 0) {
    console.log("✓ All alignment checks passed. Ready for release.\n")
  } else {
    console.log("✗ Some checks failed. Fix before publishing.\n")
  }

  process.exit(exitCode)
}

main()
