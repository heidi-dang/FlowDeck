import { existsSync, readFileSync, readdirSync } from "fs"
import { join, resolve } from "path"
import { homedir } from "os"
import type { CheckResult } from "../types"
import { getExecutingRuntimeIdentity, readRuntimeSelfReport, isRuntimeRecordFresh } from "../../services/runtime-identity"

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

  // Plugin runtime identity check: plugin.runtime_identity
  const expectedPath = resolve(directory)
  let expectedVersion = "unknown"
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
      expectedVersion = pkg.version || "unknown"
    } catch {}
  }

  const selfReport = readRuntimeSelfReport(directory)
  const executingIdentity = getExecutingRuntimeIdentity()
  const isFresh = selfReport ? isRuntimeRecordFresh(selfReport) : false;
  const loadedIdentity = (selfReport && isFresh) ? selfReport : executingIdentity;

  const loadedVersion = loadedIdentity?.version || "unknown"
  const loadedPath = loadedIdentity?.packageRoot
    ? resolve(loadedIdentity.packageRoot)
    : loadedIdentity?.moduleUrl && loadedIdentity.moduleUrl.startsWith("file://")
    ? resolve(loadedIdentity.moduleUrl.replace(/^file:\/\//, ""))
    : "unknown"

  const versionMatches = expectedVersion !== "unknown" && loadedVersion === expectedVersion
  const pathMatches =
    loadedPath === "unknown" ||
    loadedPath === expectedPath ||
    loadedIdentity?.packageName === "@heidi-dang/flowdeck"

  // Check for stale FlowDeck cache entries on disk
  const staleCacheDirs: string[] = []
  const home = homedir()
  const xdgCache = process.env.XDG_CACHE_HOME || join(home, ".cache")
  const xdgData = process.env.XDG_DATA_HOME || join(home, ".local", "share")
  const cacheRoots = [
    join(xdgCache, "opencode", "packages"),
    join(xdgData, "opencode", "packages"),
    join(home, ".cache", "opencode", "packages"),
    join(home, ".local", "share", "opencode", "packages"),
  ]

  const seenCache = new Set<string>()
  for (const cacheRoot of cacheRoots) {
    if (existsSync(cacheRoot)) {
      try {
        const entries = readdirSync(cacheRoot)
        for (const entry of entries) {
          const fullPath = join(cacheRoot, entry)
          const resolvedFull = resolve(fullPath)
          if (resolvedFull === expectedPath || resolvedFull === loadedPath) continue
          if (seenCache.has(resolvedFull)) continue
          seenCache.add(resolvedFull)

          const candidatePkg = join(fullPath, "package.json")
          let isFlowDeck = false
          if (existsSync(candidatePkg)) {
            try {
              const cPkg = JSON.parse(readFileSync(candidatePkg, "utf-8"))
              if (cPkg.name === "@heidi-dang/flowdeck" || cPkg.name === "@dv.nghiem/flowdeck" || cPkg.flowdeck) {
                isFlowDeck = true
              }
            } catch {}
          } else if (entry.toLowerCase().includes("flowdeck")) {
            isFlowDeck = true
          }
          if (isFlowDeck) {
            staleCacheDirs.push(fullPath)
          }
        }
      } catch {}
    }
  }

  const isMismatch = !versionMatches || (!pathMatches && loadedPath !== "unknown" && loadedPath !== expectedPath)

  if (isMismatch) {
    checks.push({
      id: "plugin.runtime_identity",
      title: "Plugin Runtime Identity",
      category: "plugin",
      severity: "high",
      status: "error",
      detected: `Loaded version: v${loadedVersion}, Loaded module path: ${loadedPath}`,
      expected: `Expected version: v${expectedVersion}, Expected plugin path: ${expectedPath}`,
      recommendation: `FLOWDECK_RUNTIME_IDENTITY_MISMATCH: Loaded version (v${loadedVersion}) or loaded module path (${loadedPath}) differs from expected version (v${expectedVersion}) at expected path (${expectedPath}). Process reload required.`,
      autoFixAvailable: true,
    })
  } else if (staleCacheDirs.length > 0) {
    checks.push({
      id: "plugin.runtime_identity",
      title: "Plugin Runtime Identity",
      category: "plugin",
      severity: "medium",
      status: "warning",
      detected: `Loaded version: v${loadedVersion}, Loaded module path: ${loadedPath} (matches expected), with ${staleCacheDirs.length} stale FlowDeck cache entry(ies)`,
      expected: `Expected version: v${expectedVersion}, Expected plugin path: ${expectedPath} with clean cache`,
      recommendation: `Harmless stale FlowDeck cache exists on disk (${staleCacheDirs.join(", ")}). Run auto-repair to clean up unused cache entries.`,
      autoFixAvailable: true,
    })
  } else {
    checks.push({
      id: "plugin.runtime_identity",
      title: "Plugin Runtime Identity",
      category: "plugin",
      severity: "high",
      status: "pass",
      detected: `Loaded version: v${loadedVersion}, Loaded module path: ${loadedPath}`,
      expected: `Expected version: v${expectedVersion}, Expected plugin path: ${expectedPath}`,
      recommendation: `Plugin runtime identity agrees with configuration (Expected version v${expectedVersion} vs Loaded v${loadedVersion}, Expected path ${expectedPath} vs Loaded ${loadedPath}).`,
      autoFixAvailable: false,
    })
  }

  return checks
}
