import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { CheckResult } from "../types"

export async function runPluginChecks(directory: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = []

  // Plugin identity (package.json)
  const pkgPath = join(directory, "package.json")
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
      checks.push({
        id: "plugin.identity",
        title: "Plugin Identity",
        category: "plugin",
        severity: "high",
        status: pkg.name === "@heidi-dang/flowdeck" ? "pass" : "error",
        detected: pkg.name || "unknown",
        expected: "@heidi-dang/flowdeck",
        recommendation: "Ensure package.json name is @heidi-dang/flowdeck",
        autoFixAvailable: false,
      })

      checks.push({
        id: "plugin.version",
        title: "Plugin Version",
        category: "plugin",
        severity: "info",
        status: "pass",
        detected: `v${pkg.version}`,
        expected: "latest published version",
        recommendation: `Currently v${pkg.version}`,
        autoFixAvailable: false,
      })

      // Check exports
      const hasModernContract = pkg.main === "./dist/index.js" && pkg.type === "module"
      checks.push({
        id: "plugin.contract",
        title: "Plugin Module Contract",
        category: "plugin",
        severity: "high",
        status: hasModernContract ? "pass" : "error",
        detected: hasModernContract ? "{ main, type } present" : "missing or incorrect exports",
        expected: "main: ./dist/index.js, type: module",
        recommendation: "Ensure package.json exports the modern { id, server } contract",
        autoFixAvailable: false,
      })
    } catch {
      checks.push({
        id: "plugin.package_json",
        title: "package.json Parseable",
        category: "plugin",
        severity: "high",
        status: "error",
        detected: "parse error",
        expected: "Valid JSON",
        recommendation: "Fix package.json syntax",
        autoFixAvailable: false,
      })
    }
  }

  // Dist bundle
  const distPath = join(directory, "dist", "index.js")
  checks.push({
    id: "plugin.bundle",
    title: "Plugin Bundle",
    category: "plugin",
    severity: "high",
    status: existsSync(distPath) ? "pass" : "error",
    detected: existsSync(distPath) ? "dist/index.js found" : "not found",
    expected: "dist/index.js is the compiled plugin bundle",
    recommendation: "Run npm run build to compile the plugin",
    autoFixAvailable: true,
  })

  return checks
}
