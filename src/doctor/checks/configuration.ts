import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { CheckResult } from "../types"
import { classifyDoctorEnvironment, isRepoLikeEnvironment } from "../environment"
import { readConfig as safeParseConfig } from "../../../scripts/config-mutator.mjs"

export async function runConfigurationChecks(directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []
  const env = classifyDoctorEnvironment(directory)
  const repoOnly = isRepoLikeEnvironment(env)

  // package.json required files check
  const requiredFiles = ["package.json", "tsconfig.json", "install.sh", "uninstall.sh"]
  for (const file of requiredFiles) {
    const fullPath = join(directory, file)
    const exists = existsSync(fullPath)
    const isRepoFile = file === "tsconfig.json" || file === "install.sh" || file === "uninstall.sh"
    if (!repoOnly && isRepoFile) {
      checks.push({
        id: `config.${file}`,
        title: `Config: ${file}`,
        category: "configuration",
        severity: file === "uninstall.sh" ? "low" : "medium",
        status: "skipped",
        detected: exists ? "present" : "missing",
        expected: `${file} at repository root`,
        recommendation: `Not applicable to ${env} installs — repository-only file`,
        autoFixAvailable: false,
      })
      continue
    }
    checks.push({
      id: `config.${file}`,
      title: `Config: ${file}`,
      category: "configuration",
      severity: file === "package.json" ? "high" : file === "uninstall.sh" ? "low" : "medium",
      status: exists ? "pass" : "error",
      detected: exists ? "present" : "missing",
      expected: `${file} at repository root`,
      recommendation: exists ? "OK" : `Create or restore ${file}`,
      autoFixAvailable: false,
    })
  }

  // OpenCode user config
  const configDir = process.env.OPENCODE_CONFIG_DIR ||
    (process.env.XDG_CONFIG_HOME
      ? join(process.env.XDG_CONFIG_HOME, "opencode")
      : join(homedir(), ".config", "opencode"))

  const userConfigPath = join(configDir, "opencode.json")
  if (existsSync(userConfigPath)) {
    try {
      const parsed = safeParseConfig(userConfigPath) as any
      const isOk = Boolean(parsed && parsed.ok && parsed.data)
      const parseErr = parsed?.error ?? "unknown error"

      checks.push({
        id: "config.opencode_user",
        title: "OpenCode User Config",
        category: "configuration",
        severity: "high",
        status: isOk ? "pass" : "error",
        detected: isOk ? "valid JSON/JSONC" : `parse error: ${parseErr}`,
        expected: "Valid OpenCode configuration",
        recommendation: isOk ? "OK" : "Fix syntax errors in opencode.json",
        autoFixAvailable: false,
      })

      // Check plugin array content
      if (isOk && parsed.data) {
        const plugins = Array.isArray(parsed.data.plugin) ? parsed.data.plugin : []
        const hasCurrent = plugins.some((p: string) => p === "@heidi-dang/flowdeck" || p.startsWith("@heidi-dang/flowdeck@"))
        const hasLegacy = plugins.some((p: string) => p === "@dv.nghiem/flowdeck" || p.startsWith("@dv.nghiem/flowdeck@"))

        if (hasLegacy || !hasCurrent) {
          checks.push({
            id: "plugin.registration",
            title: "Plugin Registration",
            category: "plugin",
            severity: "high",
            status: "error",
            detected: hasLegacy ? "Upstream legacy reference @dv.nghiem/flowdeck" : "Missing @heidi-dang/flowdeck in plugin list",
            expected: "@heidi-dang/flowdeck registered in opencode.json",
            recommendation: "Run `flowdeck doctor fix` to update plugin registration",
            autoFixAvailable: true,
            affectsRuntime: true,
            repairability: "automatic",
            repairAction: "repair_plugin_registration",
          })
        } else {
          checks.push({
            id: "plugin.registration",
            title: "Plugin Registration",
            category: "plugin",
            severity: "info",
            status: "pass",
            detected: "@heidi-dang/flowdeck registered",
            expected: "@heidi-dang/flowdeck registered in opencode.json",
            recommendation: "Plugin registration healthy",
            autoFixAvailable: false,
            affectsRuntime: false,
            repairability: "not-applicable",
          })
        }
      }
    } catch {
      checks.push({
        id: "config.opencode_user",
        title: "OpenCode User Config",
        category: "configuration",
        severity: "high",
        status: "error",
        detected: "unparseable",
        expected: "Valid configuration",
        recommendation: "Fix syntax errors in opencode.json",
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
      expected: "opencode.json created by installer",
      recommendation: "Run `flowdeck doctor fix` to generate opencode.json",
      autoFixAvailable: true,
      affectsRuntime: true,
      repairability: "automatic",
      repairAction: "repair_plugin_registration",
    })
  }

  // FlowDeck project config (.flowdeck.json or .flowdeck.jsonc)
  for (const name of [".flowdeck.jsonc", ".flowdeck.json"]) {
    const fullPath = join(directory, name)
    if (existsSync(fullPath)) {
      try {
        const parsed = safeParseConfig(fullPath) as any
        const isOk = Boolean(parsed && parsed.ok && parsed.data)
        const parseErr = parsed?.error ?? "unknown error"
        checks.push({
          id: `config.flowdeck_project`,
          title: `FlowDeck Project Config (${name})`,
          category: "configuration",
          severity: "medium",
          status: isOk ? "pass" : "error",
          detected: isOk ? "valid JSON/JSONC" : `parse error: ${parseErr}`,
          expected: "Valid FlowDeck configuration",
          recommendation: isOk ? "OK" : `Fix syntax errors in ${name}`,
          autoFixAvailable: false,
        })
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        checks.push({
          id: `config.flowdeck_project`,
          title: `FlowDeck Project Config (${name})`,
          category: "configuration",
          severity: "medium",
          status: "error",
          detected: `parse error: ${errMsg}`,
          expected: "Valid FlowDeck configuration",
          recommendation: `Fix syntax errors in ${name}`,
          autoFixAvailable: false,
        })
      }
    }
  }

  return checks
}