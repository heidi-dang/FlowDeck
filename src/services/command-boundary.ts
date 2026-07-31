import { execFile, execFileSync } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

export type AllowedValidationExecutable = "npm" | "bun" | "git" | "oxlint" | "tsc" | "node"

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
  "node",
])

/**
 * Flags that could cause the executed process to eval, import, or shell out.
 * Applies across all executables unless specifically permitted.
 */
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

/**
 * Git subcommands permitted for read-only validation use.
 * Write subcommands (add, commit, push, reset, merge, etc.) are not allowed.
 */
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
 * Validates a structured ValidationRequirement against strict security boundaries.
 * Throws a descriptive Error if any validation check fails.
 * This is the canonical gateway — every production execution path must call this.
 */
export function validateCommandRequirement(req: ValidationRequirement): void {
  const { executable, args } = req

  // 1. Executable must be explicitly allowlisted
  if (!ALLOWED_EXECUTABLES.has(executable)) {
    throw new Error(`Executable "${executable}" is not in the validation allowlist.`)
  }

  // 2. No path separators, NUL bytes, or path traversal in the executable name
  if (/[/\\:]|\.\./.test(executable) || executable.includes(String.fromCharCode(0))) {
    throw new Error(`Executable "${executable}" contains invalid path separators or characters.`)
  }

  // 3. Validate every argument
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new Error(`Invalid non-string argument: ${String(arg)}`)
    }

    // Reject NUL bytes
    if (arg.includes(String.fromCharCode(0))) {
      throw new Error("Command argument contains illegal NUL byte.")
    }

    // Reject shell metacharacters: backtick, $, (, ), <, >, &, |, ;, newlines
    if (/[`$()<>&|;\n\r]/.test(arg)) {
      throw new Error(`Command argument contains forbidden shell metacharacter: ${arg}`)
    }

    // Reject path traversal in arguments
    if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(arg) || arg === "..") {
      throw new Error(`Command argument contains path traversal: ${arg}`)
    }

    // Reject dangerous flags (both --flag and --flag=value forms)
    const flagName = arg.split("=")[0]
    if (DANGEROUS_FLAGS.has(arg) || DANGEROUS_FLAGS.has(flagName)) {
      throw new Error(`Dangerous command flag rejected: ${arg}`)
    }
  }

  // 4. Restrict git to approved read-only subcommands
  if (executable === "git") {
    const subcommand = args[0]
    if (!subcommand || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
      throw new Error(
        `Git subcommand "${subcommand ?? "(none)"}" is not allowed in validation boundary.`
      )
    }
  }
}

/**
 * Executes a validated command asynchronously using execFile (shell: false).
 * This is the preferred production execution path.
 */
export async function executeValidatedCommand(
  req: ValidationRequirement,
  cwd: string = process.cwd()
): Promise<CommandExecutionResult> {
  validateCommandRequirement(req)

  const timeout = req.timeoutMs ?? 10_000
  const maxBuffer = req.maxBuffer ?? 5 * 1024 * 1024 // 5 MB

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
      stderr: err.stderr ? err.stderr.toString() : (err.message ?? String(err)),
      exitCode: typeof err.code === "number" ? err.code : 1,
    }
  }
}

/**
 * Executes a validated command synchronously using execFileSync (shell: false).
 * Use only when the call site cannot be made asynchronous.
 * Does NOT use execSync — arguments are passed as an array, never shell-interpolated.
 */
export function executeValidatedCommandSync(
  req: ValidationRequirement,
  cwd: string = process.cwd()
): CommandExecutionResult {
  validateCommandRequirement(req)

  const timeout = req.timeoutMs ?? 10_000
  const maxBuffer = req.maxBuffer ?? 5 * 1024 * 1024 // 5 MB

  try {
    const stdout = execFileSync(req.executable, req.args, {
      cwd,
      timeout,
      maxBuffer,
      shell: false,
      encoding: "utf-8",
    })
    return {
      stdout: String(stdout),
      stderr: "",
      exitCode: 0,
    }
  } catch (err: any) {
    return {
      stdout: err.stdout ? String(err.stdout) : "",
      stderr: err.stderr ? String(err.stderr) : (err.message ?? String(err)),
      exitCode: typeof err.status === "number" ? err.status : 1,
    }
  }
}

/**
 * Parses a legacy bare command string into a ValidationRequirement.
 *
 * Supports ONLY explicitly approved command forms. Rejects:
 *   - pipes, redirects, semicolons, ampersands
 *   - command substitution ($(...), `...`)
 *   - environment assignment (FOO=bar ...)
 *   - unknown executables
 *   - empty commands
 *   - absolute or Windows paths
 *   - quoted arguments containing metacharacters
 *   - any compound invocation (sh -c, cmd.exe, powershell)
 *
 * Approved examples:
 *   "npm test"
 *   "npm run typecheck"
 *   "bun test tests/example.test.ts"
 *   "git status --short"
 *   "tsc --noEmit"
 *   "oxlint --deny-warnings"
 */
export function parseLegacyRequirementString(raw: string): ValidationRequirement {
  const trimmed = raw.trim()

  if (!trimmed) {
    throw new Error("Requirement string is empty.")
  }

  // Reject shell metacharacters before any splitting
  if (/[|&;<>$`\n\r]/.test(trimmed)) {
    throw new Error(
      `Requirement string contains forbidden shell syntax: "${trimmed}"`
    )
  }

  // Reject environment variable assignment prefix (e.g. "FOO=bar npm test")
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
    throw new Error(
      `Requirement string starts with an environment assignment, which is not allowed: "${trimmed}"`
    )
  }

  // Simple whitespace split — no shell quoting is supported; quoted args are rejected
  const parts = trimmed.split(/\s+/).filter(Boolean)

  if (parts.length === 0) {
    throw new Error("Requirement string produced no tokens after splitting.")
  }

  // Reject any token that contains quote characters (no shell quoting allowed)
  for (const part of parts) {
    if (/["']/.test(part)) {
      throw new Error(
        `Requirement string contains quoted argument "${part}", which is not supported in the legacy adapter.`
      )
    }
  }

  const rawExecutable = parts[0]
  const args = parts.slice(1)

  // Reject absolute paths and Windows paths in the executable position
  if (/^[/\\]/.test(rawExecutable) || /^[A-Za-z]:/.test(rawExecutable)) {
    throw new Error(
      `Requirement string executable "${rawExecutable}" must not be an absolute path.`
    )
  }

  // Reject path traversal in executable
  if (rawExecutable.includes("..") || rawExecutable.includes("/") || rawExecutable.includes("\\")) {
    throw new Error(
      `Requirement string executable "${rawExecutable}" must be a plain basename.`
    )
  }

  const ALLOWED_MAP: Partial<Record<string, AllowedValidationExecutable>> = {
    npm: "npm",
    bun: "bun",
    git: "git",
    oxlint: "oxlint",
    tsc: "tsc",
    node: "node",
  }

  const executable = ALLOWED_MAP[rawExecutable]
  if (!executable) {
    throw new Error(
      `Executable "${rawExecutable}" is not in the legacy migration allowlist.`
    )
  }

  // Perform the same arg validation the structured validator does
  const req: ValidationRequirement = { executable, args }
  validateCommandRequirement(req)

  return req
}
