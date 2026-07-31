/**
 * Doctor Environment Classification
 *
 * Classifies the directory being audited so individual checks can declare
 * applicability per environment. A healthy packed npm install must not be
 * penalised for missing repository-only artefacts (tsconfig.json,
 * uninstall.sh, .gitignore), and a source checkout must still be validated
 * against them.
 *
 * Environments:
 *   source-checkout — git repository with a source tree (development)
 *   local-repo      — repository layout without .git (local copy/link)
 *   npm             — registry install under node_modules
 *   packed          — npm tarball layout (dist/, bin/, install.sh, no repo markers)
 *   unknown         — cannot be classified
 */

import { existsSync } from "fs"
import { join } from "path"

export type DoctorEnvironment =
  | "source-checkout"
  | "local-repo"
  | "npm"
  | "packed"
  | "unknown"

/**
 * Classify the environment of a FlowDeck installation directory.
 *
 * Order matters: git-based checkouts take precedence, then node_modules
 * installs (which are always registry installs), then tarball-layout
 * detection by the absence of repository-only markers.
 */
export function classifyDoctorEnvironment(directory: string): DoctorEnvironment {
  const hasGit = existsSync(join(directory, ".git"))
  const hasDist = existsSync(join(directory, "dist", "index.js"))
  const hasSrc = existsSync(join(directory, "src"))
  const hasTsconfig = existsSync(join(directory, "tsconfig.json"))
  const hasUninstall = existsSync(join(directory, "uninstall.sh"))
  const inNodeModules = directory.includes("node_modules")

  if (hasGit && (hasSrc || hasDist)) return "source-checkout"
  if (inNodeModules && !hasGit) return "npm"
  // Packed tarballs ship dist/bin/install.sh but never tsconfig.json or uninstall.sh
  if (!hasGit && hasDist && !hasTsconfig && !hasUninstall) return "packed"
  if (!hasGit && hasSrc && hasTsconfig) return "local-repo"
  return "unknown"
}

/**
 * Whether an environment owns repository-only artefacts.
 *
 * "unknown" is treated as repo-like so the Doctor fails closed: it never
 * silently skips checks for a layout it cannot classify.
 */
export function isRepoLikeEnvironment(env: DoctorEnvironment): boolean {
  return env === "source-checkout" || env === "local-repo" || env === "unknown"
}
