/**
 * OpenCode validation executor for the Better Harness pipeline.
 *
 * All validation execution flows through the canonical structured command boundary:
 *   ValidationRequirement → validateCommandRequirement → execFileSync (shell:false)
 *
 * No execSync, exec, or shell invocation is used here.
 * Incoming legacy command strings are adapted through parseLegacyRequirementString,
 * which is fail-closed: any unsupported or unsafe string throws before process creation.
 *
 * This module deliberately does NOT maintain its own validation logic.
 * The single canonical control flow is:
 *   ValidationRequirement
 *     → validateCommandRequirement   (command-boundary.ts)
 *     → executeValidatedCommandSync  (command-boundary.ts)
 *     → structured result
 */
import {
  executeValidatedCommandSync,
  parseLegacyRequirementString,
  type ValidationRequirement,
} from "../../services/command-boundary"

export type { ValidationRequirement }

export interface ValidationResult {
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  passed: boolean
  error: string | null
}

/**
 * Executes a single legacy command string through the structured validation boundary.
 *
 * The command is parsed into a ValidationRequirement before any process is created.
 * If parsing fails for any reason (unsupported executable, shell syntax, dangerous flag,
 * NUL byte, path traversal, operation rejection, etc.) the result reflects the rejection
 * without spawning any process.
 *
 * @param command  Bare command string, e.g. "npm test" or "git status --short"
 * @param cwd      Working directory for execution
 * @param timeoutMs  Per-process wall-clock timeout in milliseconds (default: 30 000)
 */
export function executeValidation(
  command: string,
  cwd: string,
  timeoutMs = 30_000,
): ValidationResult {
  const startTime = Date.now()

  let parsed: ValidationRequirement
  try {
    parsed = parseLegacyRequirementString(command)
  } catch (parseErr: any) {
    const durationMs = Date.now() - startTime
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr)
    return {
      command,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs,
      passed: false,
      error: `Command rejected: ${msg}`,
    }
  }

  // Immutable construction — final complete requirement includes caller-specified timeout
  const req: ValidationRequirement = {
    ...parsed,
    timeoutMs,
  }

  try {
    const res = executeValidatedCommandSync(req, cwd)
    const durationMs = Date.now() - startTime

    return {
      command,
      exitCode: res.exitCode,
      stdout: res.stdout,
      stderr: res.stderr,
      durationMs,
      passed: res.exitCode === 0,
      error: res.exitCode !== 0
        ? (res.stderr.trim() || `Process exited with code ${res.exitCode}`)
        : null,
    }
  } catch (execErr: any) {
    const durationMs = Date.now() - startTime
    const msg = execErr instanceof Error ? execErr.message : String(execErr)
    return {
      command,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs,
      passed: false,
      error: `Command rejected: ${msg}`,
    }
  }
}
