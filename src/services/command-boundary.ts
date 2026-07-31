import { execFile } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

export type AllowedValidationExecutable = "npm" | "bun" | "git" | "oxlint" | "tsc"

export interface ValidationRequirement {
  executable: AllowedValidationExecutable
  args: string[]
  timeoutMs?: number
  maxBuffer?: number
}

export interface CommandExecutionResult {
  stdout: string
  stderr: string
  exitCode: number
}

const ALLOWED_EXECUTABLES: Set<AllowedValidationExecutable> = new Set([
  "npm",
  "bun",
  "git",
  "oxlint",
  "tsc",
])

const DANGEROUS_FLAGS = new Set([
  "--eval",
  "-e",
  "--exec",
  "-p",
  "--import",
  "--require",
  "--shell",
  "-c",
  "--config",
])

const ALLOWED_GIT_SUBCOMMANDS = new Set([
  "status",
  "diff",
  "log",
  "rev-parse",
  "show",
  "branch",
  "tag",
  "ls-files",
])

/**
 * Validates a command requirement against strict security boundaries.
 * Throws a descriptive Error if validation fails.
 */
export function validateCommandRequirement(req: ValidationRequirement): void {
  const { executable, args } = req

  // 1. Explicit allowlist
  if (!ALLOWED_EXECUTABLES.has(executable)) {
    throw new Error(`Executable "${executable}" is not in the validation allowlist.`)
  }

  // 2. No path separators, NUL bytes, or path traversal
  if (/[/\\:]|\.\./.test(executable) || executable.includes(String.fromCharCode(0))) {
    throw new Error(`Executable "${executable}" contains invalid path separators or characters.`)
  }

  // 3. Check args for NUL bytes, shell escape metacharacters, or dangerous flags
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new Error(`Invalid non-string argument: ${arg}`)
    }

    if (arg.includes(String.fromCharCode(0))) {
      throw new Error("Command argument contains illegal NUL byte.")
    }

    // Shell metacharacters injection check (backticks, command substitution, piping)
    if (/[`$()<>&|;\n\r]/.test(arg)) {
      throw new Error(`Command argument contains forbidden shell metacharacter: ${arg}`)
    }

    // Reject dangerous flags
    const trimmed = arg.trim()
    if (DANGEROUS_FLAGS.has(trimmed) || DANGEROUS_FLAGS.has(trimmed.split("=")[0])) {
      throw new Error(`Dangerous command flag rejected: ${arg}`)
    }
  }

  // 4. Validate git subcommands
  if (executable === "git") {
    const subcommand = args[0]
    if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
      throw new Error(`Git subcommand "${subcommand}" is not allowed in validation boundary.`)
    }
  }
}

/**
 * Safely executes a validated command using execFile (without shell invocation).
 */
export async function executeValidatedCommand(
  req: ValidationRequirement,
  cwd: string = process.cwd()
): Promise<CommandExecutionResult> {
  validateCommandRequirement(req)

  const timeout = req.timeoutMs ?? 10_000
  const maxBuffer = req.maxBuffer ?? 1024 * 1024 * 5 // 5MB limit

  try {
    const { stdout, stderr } = await execFileAsync(req.executable, req.args, {
      cwd,
      timeout,
      maxBuffer,
      shell: false,
    })
    return {
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      exitCode: 0,
    }
  } catch (err: any) {
    return {
      stdout: err.stdout ? err.stdout.toString() : "",
      stderr: err.stderr ? err.stderr.toString() : err.message || String(err),
      exitCode: typeof err.code === "number" ? err.code : 1,
    }
  }
}
