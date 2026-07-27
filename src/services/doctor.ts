/**
 * Doctor Service — bridges to the authoritative shared Doctor engine.
 *
 * The real diagnostic implementation lives in scripts/doctor-engine.mjs
 * so it's usable by both the CLI (bin/flowdeck.js) and the OpenCode
 * plugin tool (this file).
 */

import type { DiagnosticCheck, DoctorReport } from "./doctor-types"
export type { DiagnosticCheck, DoctorReport }

/** Lazily load and cache the shared engine via dynamic import */
let engineModule: any = null

export async function runDoctorChecks(directory: string): Promise<DoctorReport> {
  if (!engineModule) {
    // Dynamic import at runtime — TypeScript won't resolve the .mjs path at compile time
    engineModule = await new Function(`return import("../../scripts/doctor-engine.mjs")`)()
  }
  const result = await engineModule.runDoctorChecks(directory)
  return {
    timestamp: new Date().toISOString(),
    directory,
    passed: result.passed,
    warned: result.warned,
    failed: result.failed,
    checks: result.checks,
  }
}
