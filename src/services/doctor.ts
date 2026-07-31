/**
 * Doctor Service — bridges to the authoritative shared Doctor engine.
 *
 * The real diagnostic implementation lives in scripts/doctor-engine.mjs
 * so it's usable by both the CLI (bin/flowdeck.js) and the OpenCode
 * plugin tool (this file).
 */

import type { DiagnosticCheck, DoctorReport } from "./doctor-types"
export type { DiagnosticCheck, DoctorReport }

export class DoctorEngineLoadError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = "DoctorEngineLoadError"
  }
}

/** Lazily load and cache the shared engine via dynamic import */
let engineModule: any = null

export async function getDoctorEngine(): Promise<any> {
  if (!engineModule) {
    try {
      const engineUrl = new URL(
        "../../scripts/doctor-engine.mjs",
        import.meta.url,
      ).href
      engineModule = await import(
        /* @vite-ignore */
        engineUrl
      )
    } catch (err) {
      throw new DoctorEngineLoadError(
        `Failed to resolve Doctor engine relative to module location (${import.meta.url}): ${err instanceof Error ? err.message : String(err)}`,
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

