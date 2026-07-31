/**
 * Production requirement runner for the Better Harness verification pipeline.
 *
 * All requirement execution flows through the canonical structured command boundary:
 *   ValidationRequirement → validateCommandRequirement → execFileSync (shell:false)
 *
 * No execSync, exec, or shell invocation is used here.
 * Legacy bare string requirements are adapted through parseLegacyRequirementString,
 * which is fail-closed: any unsupported or unsafe string throws before process creation.
 */
import {
  executeValidatedCommandSync,
  parseLegacyRequirementString,
  type ValidationRequirement,
} from "../../services/command-boundary"

export type { ValidationRequirement }

export interface RequirementResult {
  /** The original requirement as supplied by the caller. */
  requirement: ValidationRequirement | string
  passed: boolean
  output: string
  error?: string
  exitCode?: number
}

/**
 * Runs all requirements in order.
 *
 * Each requirement may be either a structured ValidationRequirement (preferred)
 * or a bare legacy command string (adapted via parseLegacyRequirementString).
 *
 * A failed requirement does not stop execution — all results are collected.
 * The result array preserves input order.
 */
export function runRequirements(
  requirements: ReadonlyArray<ValidationRequirement | string>,
  cwd: string,
): RequirementResult[] {
  return requirements.map((req) => {
    let structured: ValidationRequirement

    if (typeof req === "string") {
      try {
        structured = parseLegacyRequirementString(req)
      } catch (parseErr: any) {
        // Reject at parse time — nothing is spawned
        return {
          requirement: req,
          passed: false,
          output: "",
          error: `Legacy requirement rejected: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          exitCode: 1,
        }
      }
    } else {
      structured = req
    }

    try {
      const res = executeValidatedCommandSync(structured, cwd)
      return {
        requirement: req,
        passed: res.exitCode === 0,
        output: res.stdout.trim(),
        error: res.exitCode !== 0
          ? (res.stderr.trim() || `Process exited with code ${res.exitCode}`)
          : undefined,
        exitCode: res.exitCode,
      }
    } catch (execErr: any) {
      // Validation rejection from validateCommandRequirement — nothing was spawned
      return {
        requirement: req,
        passed: false,
        output: "",
        error: `Requirement rejected: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
        exitCode: 1,
      }
    }
  })
}
