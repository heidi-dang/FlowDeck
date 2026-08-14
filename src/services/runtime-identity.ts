/**
 * FlowDeck Runtime Identity & Self-Report Service
 *
 * Captures, records, and reads runtime metadata about the executing FlowDeck process.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

export type FlowDeckRuntimeIdentity = {
  packageName: string
  version: string
  moduleUrl: string
  packageRoot: string
  source: "npm-cache" | "file" | "package" | "unknown"
  pid: number
  startedAt: string
  opencodeSession?: string
}

function safeFileURLToPath(urlOrPath: string): string {
  if (urlOrPath.startsWith("file://")) {
    try {
      return fileURLToPath(urlOrPath)
    } catch {
      return urlOrPath.replace(/^file:\/\//, "")
    }
  }
  return urlOrPath
}

function determineSource(
  moduleUrl: string,
  packageRoot: string,
  filePath: string
): FlowDeckRuntimeIdentity["source"] {
  const combined = `${moduleUrl} ${packageRoot} ${filePath}`.toLowerCase()
  if (
    combined.includes(".cache/opencode/packages") ||
    combined.includes(".cache/npm") ||
    combined.includes("npm-cache")
  ) {
    return "npm-cache"
  }
  if (combined.includes("node_modules")) {
    return "package"
  }
  if (
    moduleUrl.startsWith("file:") ||
    (packageRoot !== "unknown" && (packageRoot.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(packageRoot)))
  ) {
    return "file"
  }
  return "unknown"
}

/**
 * Derives runtime identity for the currently executing process or given module URL.
 */
export function getExecutingRuntimeIdentity(metaUrl?: string): FlowDeckRuntimeIdentity {
  const resolvedUrl =
    metaUrl || (typeof import.meta !== "undefined" && import.meta.url ? import.meta.url : "") || ""
  const filePath = safeFileURLToPath(resolvedUrl)

  let packageRoot = "unknown"
  let packageName = "unknown"
  let version = "unknown"

  if (filePath && filePath !== "unknown") {
    let currentDir =
      filePath.endsWith(".ts") ||
      filePath.endsWith(".js") ||
      filePath.endsWith(".mjs") ||
      filePath.endsWith(".cjs")
        ? dirname(filePath)
        : filePath

    while (currentDir && currentDir !== dirname(currentDir)) {
      const pkgPath = join(currentDir, "package.json")
      if (existsSync(pkgPath)) {
        try {
          const content = JSON.parse(readFileSync(pkgPath, "utf-8"))
          packageRoot = currentDir
          packageName = content.name || "unknown"
          version = content.version || "unknown"
          break
        } catch {
          // ignore parse errors and walk up
        }
      }
      currentDir = dirname(currentDir)
    }
  }

  const source = determineSource(resolvedUrl, packageRoot, filePath)
  const pid = process.pid
  const startedAt = new Date().toISOString()
  const opencodeSession =
    process.env.OPENCODE_SESSION_ID || process.env.OPENCODE_SESSION || process.env.SESSION_ID || undefined

  return {
    packageName,
    version,
    moduleUrl: resolvedUrl,
    packageRoot,
    source,
    pid,
    startedAt,
    ...(opencodeSession ? { opencodeSession } : {}),
  }
}

/**
 * Records the runtime identity self-report into `.flowdeck/runtime-self-report.json`.
 */
export function recordRuntimeSelfReport(identity: FlowDeckRuntimeIdentity, directory: string): void {
  try {
    const flowdeckDir = join(directory, ".flowdeck")
    if (!existsSync(flowdeckDir)) {
      mkdirSync(flowdeckDir, { recursive: true })
    }
    const filePath = join(flowdeckDir, "runtime-self-report.json")
    writeFileSync(filePath, JSON.stringify(identity, null, 2), "utf-8")
  } catch {
    // Ignore filesystem write failures (e.g. invalid directory, read-only filesystem, missing permissions)
  }
}

/**
 * Reads the runtime identity self-report from `.flowdeck/runtime-self-report.json`.
 */
export function readRuntimeSelfReport(directory: string): FlowDeckRuntimeIdentity | null {
  const filePath = join(directory, ".flowdeck", "runtime-self-report.json")
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const raw = readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(raw) as FlowDeckRuntimeIdentity
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.packageName === "string" &&
      typeof parsed.version === "string"
    ) {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

/**
 * Determines whether a runtime record was created within `maxAgeMs` (default 5 minutes).
 */
export function isRuntimeRecordFresh(record: FlowDeckRuntimeIdentity, maxAgeMs: number = 300_000): boolean {
  if (!record || typeof record !== "object" || !record.startedAt) {
    return false
  }
  const started = new Date(record.startedAt).getTime()
  if (isNaN(started)) {
    return false
  }
  const age = Date.now() - started
  return age >= -5000 && age <= maxAgeMs
}
