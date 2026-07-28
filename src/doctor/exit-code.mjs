/**
 * exit-code.mjs — Canonical Doctor exit-code resolver
 *
 * SINGLE dependency-free implementation shared across:
 *   - src/doctor/doctor.ts       (compiled into dist/index.js)
 *   - scripts/doctor-service.mjs (Node.js bridge)
 *   - src/doctor/cli.mjs         (standalone CLI)
 *   - bin/flowdeck.js            (packaged CLI)
 *
 * Zero runtime dependencies. Works with Node.js, Bun, and any ESM runtime.
 *
 * Exit contract:
 *   0 — healthy or degraded (normal mode)
 *   1 — unhealthy (errors > 0) or degraded in strict mode
 *   2 — engine/internal error (report is null or unparseable)
 */

/**
 * Resolve the doctor process exit code from a report or failure state.
 *
 * @param {object|null|undefined} report - Doctor report with { failed, warned, summary }
 * @param {boolean} strict - When true, warnings in normal mode cause exit 1
 * @returns {0|1|2} Exit code per the contract above
 */
export function resolveDoctorExitCode(report, strict = false) {
  // Engine or malformed-report failure
  if (report === null || report === undefined) return 2

  const errors = report.failed ?? report.summary?.errors ?? 0
  const warnings = report.warned ?? report.summary?.warnings ?? 0

  // Unhealthy: at least one error
  if (errors > 0) return 1

  // Strict mode: warnings degrade to failure
  if (strict && warnings > 0) return 1

  return 0
}
