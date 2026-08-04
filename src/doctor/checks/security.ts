import { existsSync, readFileSync } from "fs"
import { join, resolve } from "path"
import { pathToFileURL } from "url"
import type { CheckResult } from "../types"
import { classifyDoctorEnvironment, isRepoLikeEnvironment } from "../environment"

/**
 * Behavioural secret-redaction probe.
 *
 * Verifies that the redaction implementation actually redacts a synthetic
 * secret. Resolves the implementation from the packaged bundle first
 * (dist/index.js — the only location in a packed install), then falls back
 * to the TypeScript source module (development checkouts). Never reports a
 * hardcoded pass: if no implementation can be imported or the probe value is
 * not redacted, the check fails.
 */
async function probeSecretRedaction(directory: string): Promise<{ ok: boolean; detail: string }> {
  // Synthetic token: constructed at runtime so no real token-like literal appears in source.
  const probeInput = "leaked " + "npm_" + "a".repeat(40) + " token"
  const candidates: Array<{ name: string; url: string }> = []
  try {
    const p = resolve(directory, "dist", "tools", "fdx-shared.js")
    if (existsSync(p)) candidates.push({ name: "dist/tools/fdx-shared.js", url: pathToFileURL(p).href })
  } catch { /* ignore */ }
  try {
    const p = resolve(directory, "dist", "index.js")
    const hasPlugin = existsSync(resolve(directory, "node_modules", "@opencode-ai", "plugin"))
    if (existsSync(p) && hasPlugin) candidates.push({ name: "dist/index.js", url: pathToFileURL(p).href })
  } catch { /* ignore */ }
  try {
    const p = resolve(directory, "src", "tools", "fdx-shared.ts")
    if (existsSync(p)) candidates.push({ name: "src/tools/fdx-shared.ts", url: pathToFileURL(p).href })
  } catch { /* ignore */ }
  try {
    const p = resolve(directory, "src", "lib", "secret-redaction.ts")
    if (existsSync(p)) candidates.push({ name: "src/lib/secret-redaction.ts", url: pathToFileURL(p).href })
  } catch { /* ignore */ }

  for (const candidate of candidates) {
    try {
      const mod = await import(candidate.url)
      if (typeof mod.redactSecrets !== "function") continue
      const output = mod.redactSecrets(probeInput)
      if (output.includes("[REDACTED_NPM_TOKEN]")) {
        return { ok: true, detail: `behavioural probe passed via ${candidate.name}` }
      }
      return { ok: false, detail: `behavioural probe failed — secret was not redacted (${candidate.name})` }
    } catch { /* try next candidate */ }
  }
  return { ok: false, detail: "redactSecrets not importable from dist/index.js or src/lib/secret-redaction.ts" }
}

export async function runSecurityChecks(directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []
  const env = classifyDoctorEnvironment(directory)
  const repoOnly = isRepoLikeEnvironment(env)

  // .gitignore exists (repository-only: not shipped in the npm tarball)
  const gitignorePath = join(directory, ".gitignore")
  if (!repoOnly) {
    checks.push({
      id: "security.gitignore",
      title: ".gitignore",
      category: "security",
      severity: "high",
      status: "skipped",
      detected: existsSync(gitignorePath) ? "present" : "missing",
      expected: ".gitignore at repository root",
      recommendation: `Not applicable to ${env} installs — repository-only file`,
      autoFixAvailable: false,
    })
  } else {
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

  // Secret redaction — behavioural probe (works in source and packed installs)
  const redaction = await probeSecretRedaction(directory)
  checks.push({
    id: "security.secret_redaction",
    title: "Secret Redaction",
    category: "security",
    severity: "high",
    status: redaction.ok ? "pass" : "error",
    detected: redaction.ok ? "redacts synthetic secrets" : "not verified",
    expected: "Secret redaction redacts npm/GitHub/Bearer tokens in log and report output",
    recommendation: redaction.detail,
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
