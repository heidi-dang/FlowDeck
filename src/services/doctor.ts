/**
 * Doctor Service — bridges to the authoritative shared Doctor engine.
 *
 * The real diagnostic implementation lives in scripts/doctor-engine.mjs
 * so it's usable by both the CLI (bin/flowdeck.js) and the OpenCode
 * plugin tool (this file).
 */

import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { DiagnosticCheck, DoctorReport } from "./doctor-types"

export type { DiagnosticCheck, DoctorReport }

export class DoctorEngineLoadError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = "DoctorEngineLoadError"
  }
}

function normalizePath(p: string): string {
  const normalized = p.replace(/\\/g, "/")
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return normalized
  }
  if (/^\/[a-zA-Z]:\//.test(normalized)) {
    return normalized.slice(1)
  }
  return normalized
}

/**
 * Resolves the URL for scripts/doctor-engine.mjs based on the executing module's location.
 */
export function resolveDoctorEngineUrl(metaUrl: string | URL): URL {
  let filePath: string

  if (metaUrl instanceof URL) {
    filePath = metaUrl.protocol === "file:" ? fileURLToPath(metaUrl) : metaUrl.pathname
  } else if (typeof metaUrl === "string") {
    if (metaUrl.startsWith("file://")) {
      filePath = fileURLToPath(new URL(metaUrl))
    } else if (metaUrl.includes("://")) {
      filePath = new URL(metaUrl).pathname
    } else {
      filePath = resolve(metaUrl)
    }
  } else {
    throw new TypeError(`Invalid metaUrl provided: ${String(metaUrl)}`)
  }

  const normalizedPath = normalizePath(filePath)

  const dir = dirname(normalizedPath)
  const candidates: string[] = []

  if (
    normalizedPath.includes("/src/services/") ||
    normalizedPath.includes("/src/doctor/") ||
    normalizedPath.includes("/src/")
  ) {
    candidates.push(resolve(dir, "../../scripts/doctor-engine.mjs"))
    candidates.push(resolve(dir, "../scripts/doctor-engine.mjs"))
    candidates.push(resolve(dir, "../../../scripts/doctor-engine.mjs"))
  } else if (normalizedPath.includes("/dist/services/")) {
    candidates.push(resolve(dir, "../../scripts/doctor-engine.mjs"))
    candidates.push(resolve(dir, "../scripts/doctor-engine.mjs"))
    candidates.push(resolve(dir, "../../../scripts/doctor-engine.mjs"))
  } else if (normalizedPath.includes("/dist/")) {
    candidates.push(resolve(dir, "../scripts/doctor-engine.mjs"))
    candidates.push(resolve(dir, "../../scripts/doctor-engine.mjs"))
    candidates.push(resolve(dir, "../../../scripts/doctor-engine.mjs"))
  } else {
    candidates.push(resolve(dir, "../scripts/doctor-engine.mjs"))
    candidates.push(resolve(dir, "../../scripts/doctor-engine.mjs"))
    candidates.push(resolve(dir, "../../../scripts/doctor-engine.mjs"))
  }

  for (const candidate of candidates) {
    const absPath = resolve(candidate)
    if (existsSync(absPath)) {
      return pathToFileURL(absPath)
    }
  }

  return pathToFileURL(resolve(candidates[0]))
}

/** Lazily load and cache the shared engine via dynamic import */
let engineModule: any = null

export async function getDoctorEngine(): Promise<any> {
  if (!engineModule) {
    const engineUrl = resolveDoctorEngineUrl(import.meta.url)
    const targetPath = fileURLToPath(engineUrl)

    if (!existsSync(targetPath)) {
      throw new DoctorEngineLoadError(
        `Doctor engine asset missing: ${targetPath}`,
      )
    }

    try {
      engineModule = await import(
        /* @vite-ignore */
        engineUrl.href
      )
    } catch (err) {
      if (err instanceof DoctorEngineLoadError) {
        throw err
      }
      throw new DoctorEngineLoadError(
        `Failed to load Doctor engine from (${engineUrl.href}): ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
  }
  return engineModule
}

export async function runDoctorChecks(directory: string): Promise<DoctorReport> {
  const engine = await getDoctorEngine()
  const result = await engine.runDoctorChecks(directory)
  return {
    timestamp: new Date().toISOString(),
    directory,
    passed: result.passed,
    warned: result.warned,
    failed: result.failed,
    checks: result.checks,
  }
}

