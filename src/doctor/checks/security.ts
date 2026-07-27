import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { CheckResult } from "../types"

export async function runSecurityChecks(directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []

  // .gitignore exists
  const gitignorePath = join(directory, ".gitignore")
  checks.push({
    id: "security.gitignore",
    title: ".gitignore",
    category: "security",
    severity: "high",
    status: existsSync(gitignorePath) ? "pass" : "warning",
    detected: existsSync(gitignorePath) ? "present" : "missing",
    expected: ".gitignore at repository root",
    recommendation: "Create .gitignore with node_modules/, dist/, .env, .secrets",
    autoFixAvailable: false,
  })

  // .gitignore covers dist and node_modules
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8")
    const hasDist = content.includes("dist")
    const hasNodeModules = content.includes("node_modules")
    const hasEnv = content.includes(".env")

    checks.push({
      id: "security.gitignore_content",
      title: ".gitignore Coverage",
      category: "security",
      severity: "high",
      status: hasDist && hasNodeModules ? "pass" : "warning",
      detected: `dist=${hasDist}, node_modules=${hasNodeModules}, .env=${hasEnv}`,
      expected: "dist, node_modules, and .env ignored",
      recommendation: "Add dist, node_modules, .env to .gitignore",
      autoFixAvailable: false,
    })
  }

  // Check for exposed secrets in environment
  const hasNpmToken = !!process.env.NPM_TOKEN
  checks.push({
    id: "security.npm_token",
    title: "npm Token",
    category: "security",
    severity: "medium",
    status: hasNpmToken ? "pass" : "info",
    detected: hasNpmToken ? "[SET]" : "[NOT SET]",
    expected: "Required for npm publish",
    recommendation: hasNpmToken ? "OK — ensure it never appears in logs or output" : "Set NPM_TOKEN for publishing",
    autoFixAvailable: false,
  })

  // Secret redaction in source
  const redactionPath = join(directory, "src", "lib", "secret-redaction.ts")
  checks.push({
    id: "security.secret_redaction",
    title: "Secret Redaction",
    category: "security",
    severity: "high",
    status: existsSync(redactionPath) ? "pass" : "error",
    detected: existsSync(redactionPath) ? "present" : "missing",
    expected: "src/lib/secret-redaction.ts implements output sanitisation",
    recommendation: "Implement secret redaction for all log and report output",
    autoFixAvailable: false,
  })

  // npmrc exists
  const npmrcPath = join(process.env.HOME || "/root", ".npmrc")
  checks.push({
    id: "security.npmrc",
    title: ".npmrc",
    category: "security",
    severity: "low",
    status: existsSync(npmrcPath) ? "pass" : "info",
    detected: existsSync(npmrcPath) ? "present" : "not found",
    expected: "Optional — contains npm token for publishing",
    recommendation: "Create .npmrc with //registry.npmjs.org/:_authToken=${NPM_TOKEN}",
    autoFixAvailable: false,
  })

  return checks
}
