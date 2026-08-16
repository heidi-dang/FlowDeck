/**
 * Doctor Environment Classification
 *
 * Classifies the directory being audited so individual checks can declare
 * applicability per environment. A healthy packed npm install must not be
 * penalised for missing repository-only artefacts (tsconfig.json,
 * uninstall.sh, .gitignore), and a source checkout must still be validated
 * against them.
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"

export type DoctorEnvironment =
  | "source-checkout"
  | "local-repo"
  | "npm"
  | "packed"
  | "unknown"

/**
 * Resolve the authoritative FlowDeck package directory for a given directory or target.
 */
export function resolveFlowDeckPackageDir(directory: string): string {
  // 1. If directory is itself the FlowDeck package (has package.json with name @heidi-dang/flowdeck)
  const directPkg = join(directory, "package.json")
  if (existsSync(directPkg)) {
    try {
      const parsed = JSON.parse(readFileSync(directPkg, "utf-8"))
      if (parsed.name === "@heidi-dang/flowdeck") {
        return directory
      }
    } catch { /* ignore */ }
  }

  // 2. Check if installed in node_modules under directory
  const installedPkg = join(directory, "node_modules", "@heidi-dang", "flowdeck")
  if (existsSync(join(installedPkg, "package.json"))) {
    return installedPkg
  }

  // 3. Fallback to executing module location or directory
  return directory
}

/**
 * Classify the environment of a FlowDeck installation directory.
 */
export function classifyDoctorEnvironment(directory: string): DoctorEnvironment {
  const pkgDir = resolveFlowDeckPackageDir(directory)
  const hasGit = existsSync(join(pkgDir, ".git"))
  const hasDist = existsSync(join(pkgDir, "dist", "index.js"))
  const hasSrc = existsSync(join(pkgDir, "src"))
  const hasTsconfig = existsSync(join(pkgDir, "tsconfig.json"))
  const hasUninstall = existsSync(join(pkgDir, "uninstall.sh"))
  const inNodeModules = pkgDir.includes("node_modules")

  if (hasGit && (hasSrc || hasDist)) return "source-checkout"
  if (inNodeModules && !hasGit) return "npm"
  if (!hasGit && hasDist && !hasTsconfig && !hasUninstall) return "packed"
  if (!hasGit && hasSrc && hasTsconfig) return "local-repo"
  return "unknown"
}

export function isRepoLikeEnvironment(env: DoctorEnvironment): boolean {
  return env === "source-checkout" || env === "local-repo" || env === "unknown"
}
