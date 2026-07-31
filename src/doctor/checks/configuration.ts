import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { CheckResult } from "../types"
import { safeParseConfig } from "../../../scripts/config-mutator.mjs"
import { classifyDoctorEnvironment, isRepoLikeEnvironment } from "../environment"

// repoOnly files exist in source checkouts but are not shipped in the npm
// tarball (see package.json "files"). They must not fail a healthy packed install.
const CONFIG_FILES = [
  { name: "package.json", path: "package.json", severity: "high", repoOnly: false },
  { name: "tsconfig.json", path: "tsconfig.json", severity: "medium", repoOnly: true },
  { name: "install.sh", path: "install.sh", severity: "medium", repoOnly: false },
  { name: "uninstall.sh", path: "uninstall.sh", severity: "low", repoOnly: true },
]

export async function runConfigurationChecks(directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []
  const env = classifyDoctorEnvironment(directory)
  const repoOnly = isRepoLikeEnvironment(env)

  for (const file of CONFIG_FILES) {
    const fullPath = join(directory, file.path)
    const exists = existsSync(fullPath)

    if (file.repoOnly && !repoOnly) {
      checks.push({
        id: `config.${file.name}`,
        title: `Config: ${file.name}`,
        category: "configuration",
        severity: file.severity as "high" | "medium" | "low",
        status: "skipped",
        detected: exists ? "present" : "missing",
        expected: `${file.path} at repository root`,
        recommendation: `Not applicable to ${env} installs — repository-only file`,
        autoFixAvailable: false,
      })
      continue
    }

    checks.push({
      id: `config.${file.name}`,
      title: `Config: ${file.name}`,
      category: "configuration",
      severity: file.severity as "high" | "medium" | "low",
      status: exists ? "pass" : "error",
      detected: exists ? "present" : "missing",
      expected: `${file.path} at repository root`,
      recommendation: exists ? "OK" : `Create or restore ${file.path}`,
      autoFixAvailable: false,
    })
  }

  // OpenCode user config
  const home = process.env.HOME || "/root"
  const userConfigPath = join(home, ".config", "opencode", "opencode.json")
  if (existsSync(userConfigPath)) {
    try {
      const raw = readFileSync(userConfigPath, "utf-8")
      const parsed = safeParseConfig(raw)
      checks.push({
        id: "config.opencode_user",
        title: "OpenCode User Config",
        category: "configuration",
        severity: "high",
        status: parsed.ok ? "pass" : "error",
        detected: parsed.ok ? "valid JSON/JSONC" : `parse error: ${parsed.error}`,
        expected: "Valid OpenCode configuration",
        recommendation: parsed.ok ? "OK" : "Fix syntax errors in opencode.json",
        autoFixAvailable: false,
      })
    } catch {
      checks.push({
        id: "config.opencode_user",
        title: "OpenCode User Config",
        category: "configuration",
        severity: "high",
        status: "error",
        detected: "unparseable",
        expected: "Valid configuration",
        recommendation: "Fix syntax errors in ~/.config/opencode/opencode.json",
        autoFixAvailable: false,
      })
    }
  } else {
    checks.push({
      id: "config.opencode_user",
      title: "OpenCode User Config",
      category: "configuration",
      severity: "medium",
      status: "info",
      detected: "not found",
      expected: "~/.config/opencode/opencode.json created by installer",
      recommendation: "Run the FlowDeck installer: curl -fsSL https://raw.githubusercontent.com/heidi-dang/FlowDeck/main/install.sh | bash",
      autoFixAvailable: true,
    })
  }

  // FlowDeck project config (.flowdeck.json or .flowdeck.jsonc)
  for (const name of [".flowdeck.jsonc", ".flowdeck.json"]) {
    const fullPath = join(directory, name)
    if (existsSync(fullPath)) {
      try {
        const raw = readFileSync(fullPath, "utf-8")
        const parsed = safeParseConfig(raw)
        checks.push({
          id: `config.flowdeck_project`,
          title: `FlowDeck Project Config (${name})`,
          category: "configuration",
          severity: "medium",
          status: parsed.ok ? "pass" : "error",
          detected: parsed.ok ? "valid configuration" : "parse error",
          expected: "Valid flowdeck configuration",
          recommendation: parsed.ok ? "OK" : `Fix syntax errors in ${name}`,
          autoFixAvailable: false,
        })
      } catch {
        /* ignore */
      }
      break
    }
  }

  // tsconfig strict mode
  const tsconfigPath = join(directory, "tsconfig.json")
  if (existsSync(tsconfigPath)) {
    try {
      const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf-8"))
      const strict = tsconfig.compilerOptions?.strict === true
      checks.push({
        id: "config.tsconfig_strict",
        title: "TypeScript Strict Mode",
        category: "configuration",
        severity: "high",
        status: strict ? "pass" : "warning",
        detected: strict ? "strict: true" : "strict not set",
        expected: "strict: true in tsconfig.json compilerOptions",
        recommendation: "Enable strict mode: compilerOptions.strict = true",
        autoFixAvailable: false,
      })
    } catch { /* ignore */ }
  }

  return checks
}
