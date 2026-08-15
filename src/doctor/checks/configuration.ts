import { existsSync, } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { CheckResult } from "../types"
import { readConfig as safeParseConfig } from "../../../scripts/config-mutator.mjs"

export async function runConfigurationChecks(directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []

  // package.json required files check
  const requiredFiles = ["package.json", "tsconfig.json", "install.sh", "uninstall.sh"]
  for (const file of requiredFiles) {
    const fullPath = join(directory, file)
    const exists = existsSync(fullPath)
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
      const parsed = safeParseConfig(userConfigPath)
      const isOk = Boolean(parsed && !parsed.parseError && parsed.existing)
      const parseErr = parsed?.parseError ?? "unknown error"

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
      if (isOk && parsed.existing) {
        const plugins = Array.isArray(parsed.existing.plugin) ? parsed.existing.plugin : []
        const hasCurrent = plugins.includes("@heidi-dang/flowdeck")
        const hasLegacy = plugins.includes("@dv.nghiem/flowdeck")

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
        const parsed = safeParseConfig(fullPath)
        const isOk = Boolean(parsed && !parsed.parseError && parsed.existing)
        const parseErr = parsed?.parseError ?? "unknown error"
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
      } catch {
        // ignore
      }
    }
  }

  return checks
}
