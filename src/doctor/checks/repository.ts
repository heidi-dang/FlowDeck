import { execFileSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { CheckResult } from "../types"

export async function runRepositoryChecks(directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []
  const pkgPath = join(directory, "package.json")

  // Repository integrity
  const hasPackageJson = existsSync(pkgPath)
  checks.push({
    id: "repo.package_json",
    title: "Package Manifest",
    category: "repository",
    severity: "high",
    status: hasPackageJson ? "pass" : "error",
    detected: hasPackageJson ? "package.json found" : "not found",
    expected: "package.json at repository root",
    recommendation: "Install FlowDeck from npm or clone the repository",
    autoFixAvailable: false,
  })

  // Git repository
  const hasGit = existsSync(join(directory, ".git"))
  checks.push({
    id: "repo.git",
    title: "Git Repository",
    category: "repository",
    severity: "high",
    status: hasGit ? "pass" : "warning",
    detected: hasGit ? ".git found" : "not found",
    expected: "Git repository initialized",
    recommendation: "Run git init or clone from: git clone https://github.com/heidi-dang/FlowDeck.git",
    autoFixAvailable: false,
  })

  // Git branch
  if (hasGit) {
    try {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: directory, encoding: "utf-8", timeout: 5000 }).trim()
      checks.push({
        id: "repo.branch",
        title: "Current Branch",
        category: "repository",
        severity: "info",
        status: "pass",
        detected: branch,
        expected: "main or feature branch",
        recommendation: `Currently on: ${branch}`,
        autoFixAvailable: false,
      })
    } catch { /* ignore */ }
  }

  // Package manager
  if (hasPackageJson) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
    const pkgManager = pkg.packageManager || "npm"
    checks.push({
      id: "repo.package_manager",
      title: "Package Manager",
      category: "repository",
      severity: "info",
      status: "pass",
      detected: pkgManager,
      expected: "npm (with bun for development)",
      recommendation: "OK",
      autoFixAvailable: false,
    })
  }

  // Lockfiles
  const hasLockfile = existsSync(join(directory, "package-lock.json"))
  checks.push({
    id: "repo.lockfile",
    title: "Lockfile",
    category: "repository",
    severity: "medium",
    status: hasLockfile ? "pass" : "warning",
    detected: hasLockfile ? "package-lock.json found" : "not found",
    expected: "package-lock.json committed",
    recommendation: "Run npm install to generate package-lock.json",
    autoFixAvailable: false,
  })

  return checks
}
