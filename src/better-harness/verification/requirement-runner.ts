/**
 * Production requirement runner for the Better Harness verification pipeline.
 *
 * All requirement execution flows through the canonical structured command boundary:
 *   ValidationRequirement → validateCommandRequirement → process adapter
 *
 * No execSync, exec, or shell invocation is used here.
 * Legacy bare string requirements are adapted through parseLegacyRequirementString,
 * which is fail-closed: any unsupported or unsafe string throws before process creation.
 */
import {
  executeValidatedCommandSync,
  parseLegacyRequirementString,
  type CommandExecutionStatus,
  type ValidationRequirement,
} from "../../services/command-boundary"

export type { ValidationRequirement }

export interface RequirementResult {
  /** The original requirement as supplied by the caller. */
  requirement: ValidationRequirement | string
  passed: boolean
  output: string
  error?: string
  exitCode?: number | null
  status: CommandExecutionStatus | "parse_rejected" | "authorization_rejected"
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
        return {
          requirement: req,
          passed: false,
          output: "",
          error: `Legacy requirement rejected: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
          exitCode: null,
          status: "parse_rejected",
        }
      }
    } else {
      structured = req
    }

    try {
      const res = executeValidatedCommandSync(structured, cwd)

      if (res.status === "success") {
        return {
          requirement: req,
          passed: true,
          output: res.stdout.trim(),
          exitCode: 0,
          status: "success",
        }
      }

      if (res.status === "nonzero_exit") {
        return {
          requirement: req,
          passed: false,
          output: res.stdout.trim(),
          error: res.stderr.trim() || `Process exited with code ${res.exitCode}`,
          exitCode: res.exitCode,
          status: "nonzero_exit",
        }
      }

      // Timeout, max_buffer_exceeded, executable_not_found
      return {
        requirement: req,
        passed: false,
        output: res.stdout ? res.stdout.trim() : "",
        error: res.message,
        exitCode: null,
        status: res.status,
      }
    } catch (execErr: any) {
      return {
        requirement: req,
        passed: false,
        output: "",
        error: `Requirement rejected: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
        exitCode: null,
        status: "authorization_rejected",
      }
    }
  })
}
