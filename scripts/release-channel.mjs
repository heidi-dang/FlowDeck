#!/usr/bin/env node
/**
 * release-channel.mjs — npm dist-tag derivation for FlowDeck releases.
 *
 * Single source of truth for mapping a package version to its npm dist-tag:
 *
 *   - alpha.* → "alpha"
 *   - beta.*  → "beta"
 *   - rc.*    → "next"
 *   - stable  → "latest"
 *
 * Usage:
 *   node scripts/release-channel.mjs            # reads package.json version
 *   node scripts/release-channel.mjs 2.0.0-beta  # explicit version
 *
 * Output: the dist-tag ("alpha" | "beta" | "next" | "latest") on stdout.
 */

import { readFileSync } from "node:fs"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, "..")

export function resolveReleaseChannel(version) {
  if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-(alpha|beta|rc)\.[0-9]+)$/.test(version) && !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    throw new Error(`release-channel: invalid version "${version}"`)
  }
  const prerelease = version.match(/^[0-9]+\.[0-9]+\.[0-9]+-(alpha|beta|rc)\.[0-9]+$/)?.[1]
  return prerelease === "alpha" ? "alpha" : prerelease === "beta" ? "beta" : prerelease === "rc" ? "next" : "latest"
}

function main() {
  const explicit = process.argv[2]
  let version = explicit
  if (!version) {
    try {
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"))
      version = pkg.version
    } catch (err) {
      console.error(`release-channel: cannot read package.json: ${err.message}`)
      process.exit(1)
    }
  }
  try {
    process.stdout.write(resolveReleaseChannel(version) + "\n")
  } catch (err) {
    console.error(`release-channel: ${err.message}`)
    process.exit(1)
  }
}

// Run only when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}
