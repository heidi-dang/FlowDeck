import { execFile, execFileSync } from "child_process"
import { promisify } from "util"

const execFileAsync = promisify(execFile)

export type AllowedValidationExecutable = "npm" | "bun" | "git" | "oxlint" | "tsc" | "node"

export type CommandExecutionStatus =
  | "success"
  | "timeout"
  | "max_buffer_exceeded"
  | "executable_not_found"
  | "nonzero_exit"

export type CommandExecutionResult =
  | {
      status: "success"
      exitCode: 0
      stdout: string
      stderr: string
      signal: null
    }
  | {
      status: "nonzero_exit"
      exitCode: number
      stdout: string
      stderr: string
      signal: NodeJS.Signals | null
    }
  | {
      status: "timeout" | "max_buffer_exceeded" | "executable_not_found"
      exitCode: null
      stdout: string
      stderr: string
      signal: NodeJS.Signals | null
      message: string
    }

export interface ValidationRequirement {
  executable: AllowedValidationExecutable
  args: string[]
  timeoutMs?: number
  maxBuffer?: number
}

export interface ProcessAdapterInput {
  executable: string
  args: string[]
  cwd: string
  timeoutMs: number
  maxBuffer: number
}

export type ProcessAdapterSync = (input: ProcessAdapterInput) => CommandExecutionResult
export type ProcessAdapterAsync = (input: ProcessAdapterInput) => Promise<CommandExecutionResult>

export const DEFAULT_TIMEOUT_MS = 10_000
export const MIN_TIMEOUT_MS = 100
export const MAX_TIMEOUT_MS = 120_000

export const DEFAULT_MAX_BUFFER = 5 * 1024 * 1024 // 5 MB
export const MIN_MAX_BUFFER = 1024 // 1 KB
export const MAX_MAX_BUFFER = 16 * 1024 * 1024 // 16 MB

const ALLOWED_EXECUTABLES: Set<AllowedValidationExecutable> = new Set([
  "npm",
  "bun",
  "git",
  "oxlint",
  "tsc",
  "node",
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

const APPROVED_NPM_RUN_SCRIPTS = new Set([
  "lint",
  "typecheck",
  "build",
  "validate:docs",
  "test:coverage",
])

const APPROVED_BUN_RUN_SCRIPTS = new Set([
  "lint",
  "typecheck",
  "build",
])

let activeSyncAdapter: ProcessAdapterSync | null = null
let activeAsyncAdapter: ProcessAdapterAsync | null = null
let adapterInvocationCount = 0

export function getAdapterInvocationCount(): number {
  return adapterInvocationCount
}

export function resetAdapterInvocationCount(): void {
  adapterInvocationCount = 0
}

export function setTestProcessAdapters(
  syncAdapter: ProcessAdapterSync | null = null,
  asyncAdapter: ProcessAdapterAsync | null = null
): void {
  activeSyncAdapter = syncAdapter
  activeAsyncAdapter = asyncAdapter
}

/**
 * Classifies child process execution errors into discriminated result states.
 */
export function classifyChildProcessError(err: any): CommandExecutionResult {
  const stdout = err.stdout ? String(err.stdout) : ""
  const stderr = err.stderr ? String(err.stderr) : ""
  const signal = err.signal ? (err.signal as NodeJS.Signals) : null

  // 1. Executable missing
  if (err.code === "ENOENT") {
    return {
      status: "executable_not_found",
      exitCode: null,
      stdout,
      stderr,
      signal,
      message: `Executable "${err.path ?? "binary"}" not found on system path.`,
    }
  }

  // 2. Output buffer limit exceeded
  if (
    err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    err.code === "ENOBUFS" ||
    (typeof err.message === "string" && err.message.includes("maxBuffer"))
  ) {
    return {
      status: "max_buffer_exceeded",
      exitCode: null,
      stdout: stdout.slice(0, MAX_MAX_BUFFER),
      stderr: stderr.slice(0, MAX_MAX_BUFFER),
      signal,
      message: "Command stdout/stderr output exceeded configured maxBuffer limit.",
    }
  }

  // 3. Timeout limit exceeded
  if (
    err.code === "ETIMEDOUT" ||
    err.killed === true ||
    (typeof err.message === "string" &&
      (err.message.includes("timed out") || err.message.includes("ETIMEDOUT")))
  ) {
    return {
      status: "timeout",
      exitCode: null,
      stdout,
      stderr,
      signal: signal ?? "SIGTERM",
      message: "Command execution timed out.",
    }
  }

  // 4. Ordinary non-zero exit code
  const exitCode =
    typeof err.status === "number"
      ? err.status
      : typeof err.code === "number"
      ? err.code
      : 1
  return {
    status: "nonzero_exit",
    exitCode,
    stdout,
    stderr,
    signal,
  }
}

/**
 * Canonical synchronous process execution adapter (shell: false).
 */
export function defaultProcessAdapterSync(input: ProcessAdapterInput): CommandExecutionResult {
  try {
    const stdout = execFileSync(input.executable, input.args, {
      cwd: input.cwd,
      timeout: input.timeoutMs,
      maxBuffer: input.maxBuffer,
      shell: false,
      encoding: "utf-8",
    })
    return {
      status: "success",
      exitCode: 0,
      stdout: String(stdout),
      stderr: "",
      signal: null,
    }
  } catch (err: any) {
    return classifyChildProcessError(err)
  }
}

/**
 * Canonical asynchronous process execution adapter (shell: false).
 */
export async function defaultProcessAdapterAsync(
  input: ProcessAdapterInput
): Promise<CommandExecutionResult> {
  try {
    const { stdout, stderr } = await execFileAsync(input.executable, input.args, {
      cwd: input.cwd,
      timeout: input.timeoutMs,
      maxBuffer: input.maxBuffer,
      shell: false,
    })
    return {
      status: "success",
      exitCode: 0,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      signal: null,
    }
  } catch (err: any) {
    return classifyChildProcessError(err)
  }
}

/**
 * Validates timeout and maxBuffer values against hard bounds.
 */
export function validateResourceLimits(
  timeoutMs?: number,
  maxBuffer?: number
): { timeoutMs: number; maxBuffer: number } {
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (
    typeof timeout !== "number" ||
    !Number.isFinite(timeout) ||
    !Number.isInteger(timeout) ||
    timeout < MIN_TIMEOUT_MS ||
    timeout > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `Invalid timeoutMs "${timeoutMs}". Must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms.`
    )
  }

  const buffer = maxBuffer ?? DEFAULT_MAX_BUFFER
  if (
    typeof buffer !== "number" ||
    !Number.isFinite(buffer) ||
    !Number.isInteger(buffer) ||
    buffer < MIN_MAX_BUFFER ||
    buffer > MAX_MAX_BUFFER
  ) {
    throw new Error(
      `Invalid maxBuffer "${maxBuffer}". Must be an integer between ${MIN_MAX_BUFFER} and ${MAX_MAX_BUFFER} bytes.`
    )
  }

  return { timeoutMs: timeout, maxBuffer: buffer }
}

/**
 * Validates git operations to ensure only read-only subcommands and safe argument forms are permitted.
 */
export function validateGitRequirement(args: string[]): void {
  const subcommand = args[0]
  if (!subcommand) {
    throw new Error('Git subcommand is required (e.g. "git status").')
  }

  const subArgs = args.slice(1)

  switch (subcommand) {
    case "status": {
      if (subArgs.length === 0) return
      if (subArgs.length === 1 && (subArgs[0] === "--short" || subArgs[0] === "--porcelain")) return
      throw new Error(`Git status operation with arguments [${subArgs.join(", ")}] is not allowed.`)
    }
    case "diff": {
      if (subArgs.length === 0) return
      if (subArgs.length === 1 && (subArgs[0] === "--stat" || subArgs[0] === "--name-only")) return
      if (subArgs.length <= 2 && subArgs.every((a) => /^[a-zA-Z0-9_.~^-]+$/.test(a) && !a.startsWith("-"))) return
      throw new Error(`Git diff operation with arguments [${subArgs.join(", ")}] is not allowed.`)
    }
    case "log": {
      if (subArgs.length === 0) return
      if (subArgs.length === 1 && subArgs[0] === "--oneline") return
      if (subArgs.length === 2 && subArgs[0] === "-n" && /^\d+$/.test(subArgs[1])) return
      throw new Error(`Git log operation with arguments [${subArgs.join(", ")}] is not allowed.`)
    }
    case "rev-parse": {
      if (subArgs.length === 1 && (subArgs[0] === "HEAD" || subArgs[0] === "--show-toplevel")) return
      throw new Error(`Git rev-parse operation with arguments [${subArgs.join(", ")}] is not allowed.`)
    }
    case "show": {
      if (subArgs.length === 0 || (subArgs.length === 1 && subArgs[0] === "HEAD")) return
      throw new Error(`Git show operation with arguments [${subArgs.join(", ")}] is not allowed.`)
    }
    case "ls-files": {
      if (subArgs.length === 0) return
      throw new Error(`Git ls-files operation with arguments [${subArgs.join(", ")}] is not allowed.`)
    }
    case "branch": {
      if (subArgs.length === 1 && (subArgs[0] === "--show-current" || subArgs[0] === "--list" || subArgs[0] === "-l")) return
      throw new Error(`Git branch operation with arguments [${subArgs.join(", ")}] is not allowed. Only read-only branch queries are permitted.`)
    }
    case "tag": {
      if (subArgs.length === 1 && (subArgs[0] === "--list" || subArgs[0] === "-l")) return
      throw new Error(`Git tag operation with arguments [${subArgs.join(", ")}] is not allowed. Only read-only tag queries are permitted.`)
    }
    default: {
      throw new Error(`Git subcommand "${subcommand}" is not allowed in validation boundary.`)
    }
  }
}

/**
 * Validates npm operations to ensure only approved non-mutating validation commands are permitted.
 */
export function validateNpmRequirement(args: string[]): void {
  if (args.length === 0) {
    throw new Error('npm requirement requires arguments (e.g. "npm --version" or "npm test").')
  }

  const primary = args[0]

  if (primary === "--version" || primary === "-v") {
    if (args.length === 1) return
    throw new Error(`npm --version does not accept additional arguments.`)
  }

  if (primary === "test") {
    if (args.length === 1) return
    throw new Error(`npm test does not accept additional arguments in validation boundary.`)
  }

  if (primary === "run") {
    if (args.length === 2 && APPROVED_NPM_RUN_SCRIPTS.has(args[1])) return
    throw new Error(
      `npm run script "${args[1] ?? ""}" is not allowed. Approved scripts: ${Array.from(APPROVED_NPM_RUN_SCRIPTS).join(", ")}.`
    )
  }

  throw new Error(`npm command "npm ${args.join(" ")}" is not allowed in validation boundary. Mutating and arbitrary npm commands are rejected.`)
}

/**
 * Validates bun operations to ensure only approved non-mutating validation commands are permitted.
 */
export function validateBunRequirement(args: string[]): void {
  if (args.length === 0) {
    throw new Error('bun requirement requires arguments (e.g. "bun --version" or "bun test").')
  }

  const primary = args[0]

  if (primary === "--version" || primary === "-v") {
    if (args.length === 1) return
    throw new Error(`bun --version does not accept additional arguments.`)
  }

  if (primary === "test") {
    if (args.length === 1) return
    if (args.length === 2) {
      const testPath = args[1]
      if (/^[/\\]|[a-zA-Z]:/.test(testPath) || testPath.includes("..")) {
        throw new Error(`bun test path "${testPath}" must be a safe repository-relative path without traversal.`)
      }
      if (
        testPath.startsWith("tests/") ||
        /\.(?:test|spec)\.(?:ts|js)$/.test(testPath)
      ) {
        return
      }
      throw new Error(`bun test path "${testPath}" is not in an approved test location.`)
    }
    throw new Error(`bun test does not accept arbitrary flags or extra arguments in validation boundary.`)
  }

  if (primary === "run") {
    if (args.length === 2 && APPROVED_BUN_RUN_SCRIPTS.has(args[1])) return
    throw new Error(
      `bun run script "${args[1] ?? ""}" is not allowed. Approved scripts: ${Array.from(APPROVED_BUN_RUN_SCRIPTS).join(", ")}.`
    )
  }

  throw new Error(`bun command "bun ${args.join(" ")}" is not allowed in validation boundary. Mutating and arbitrary bun commands are rejected.`)
}

/**
 * Validates node operations to permit ONLY version queries.
 */
export function validateNodeRequirement(args: string[]): void {
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
    return
  }
  throw new Error(`Node requirement allows only "node --version" or "node -v". Arbitrary script execution is rejected.`)
}

/**
 * Validates tsc operations to permit ONLY approved validation flags.
 */
export function validateTscRequirement(args: string[]): void {
  if (args.length === 1 && args[0] === "--noEmit") {
    return
  }
  throw new Error(`tsc requirement allows only "tsc --noEmit".`)
}

/**
 * Validates oxlint operations to permit ONLY approved validation flags and safe targets.
 */
export function validateOxlintRequirement(args: string[]): void {
  if (args.length === 0) return
  if (args.length === 1 && args[0] === "--deny-warnings") return
  if (args.length === 1 || (args.length === 2 && args[0] === "--deny-warnings")) {
    const target = args[args.length - 1]
    if (!target.startsWith("-") && !/^[/\\]|[a-zA-Z]:/.test(target) && !target.includes("..")) {
      return
    }
  }
  throw new Error(`oxlint requirement allows only "oxlint --deny-warnings" or safe relative targets.`)
}

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

  // 3. Resource limit validation
  validateResourceLimits(req.timeoutMs, req.maxBuffer)

  // 4. Check args for NUL bytes, shell escape metacharacters, or dangerous flags
  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new Error(`Invalid non-string argument: ${String(arg)}`)
    }

    if (arg.includes(String.fromCharCode(0))) {
      throw new Error("Command argument contains illegal NUL byte.")
    }

    if (/[`$()<>&|;\n\r]/.test(arg)) {
      throw new Error(`Command argument contains forbidden shell metacharacter: ${arg}`)
    }

    if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(arg) || arg === "..") {
      throw new Error(`Command argument contains path traversal: ${arg}`)
    }

    const flagName = arg.split("=")[0]
    if (DANGEROUS_FLAGS.has(arg) || DANGEROUS_FLAGS.has(flagName)) {
      throw new Error(`Dangerous command flag rejected: ${arg}`)
    }
  }

  // 5. Operation-level policies per executable
  switch (executable) {
    case "git":
      validateGitRequirement(args)
      break
    case "npm":
      validateNpmRequirement(args)
      break
    case "bun":
      validateBunRequirement(args)
      break
    case "node":
      validateNodeRequirement(args)
      break
    case "tsc":
      validateTscRequirement(args)
      break
    case "oxlint":
      validateOxlintRequirement(args)
      break
  }
}

/**
 * Safely executes a validated command asynchronously using the canonical process adapter.
 */
export async function executeValidatedCommand(
  req: ValidationRequirement,
  cwd: string = process.cwd()
): Promise<CommandExecutionResult> {
  validateCommandRequirement(req)
  const { timeoutMs: timeout, maxBuffer: buffer } = validateResourceLimits(
    req.timeoutMs,
    req.maxBuffer
  )

  adapterInvocationCount++

  const input: ProcessAdapterInput = {
    executable: req.executable,
    args: req.args,
    cwd,
    timeoutMs: timeout,
    maxBuffer: buffer,
  }

  if (activeAsyncAdapter) {
    return activeAsyncAdapter(input)
  }

  return defaultProcessAdapterAsync(input)
}

/**
 * Safely executes a validated command synchronously using the canonical process adapter.
 */
export function executeValidatedCommandSync(
  req: ValidationRequirement,
  cwd: string = process.cwd()
): CommandExecutionResult {
  validateCommandRequirement(req)
  const { timeoutMs: timeout, maxBuffer: buffer } = validateResourceLimits(
    req.timeoutMs,
    req.maxBuffer
  )

  adapterInvocationCount++

  const input: ProcessAdapterInput = {
    executable: req.executable,
    args: req.args,
    cwd,
    timeoutMs: timeout,
    maxBuffer: buffer,
  }

  if (activeSyncAdapter) {
    return activeSyncAdapter(input)
  }

  return defaultProcessAdapterSync(input)
}

/**
 * Parses a legacy bare command string into a ValidationRequirement.
 */
export function parseLegacyRequirementString(raw: string): ValidationRequirement {
  const trimmed = raw.trim()

  if (!trimmed) {
    throw new Error("Requirement string is empty.")
  }

  if (/[|&;<>$`\n\r]/.test(trimmed)) {
    throw new Error(`Requirement string contains forbidden shell syntax: "${trimmed}"`)
  }

  if (/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(trimmed)) {
    throw new Error(
      `Requirement string starts with an environment assignment, which is not allowed: "${trimmed}"`
    )
  }

  const parts = trimmed.split(/\s+/).filter(Boolean)

  if (parts.length === 0) {
    throw new Error("Requirement string produced no tokens after splitting.")
  }

  for (const part of parts) {
    if (/["']/.test(part)) {
      throw new Error(
        `Requirement string contains quoted argument "${part}", which is not supported in the legacy adapter.`
      )
    }
  }

  const rawExecutable = parts[0]
  const args = parts.slice(1)

  if (/^[/\\]/.test(rawExecutable) || /^[A-Za-z]:/.test(rawExecutable)) {
    throw new Error(`Requirement string executable "${rawExecutable}" must not be an absolute path.`)
  }

  if (rawExecutable.includes("..") || rawExecutable.includes("/") || rawExecutable.includes("\\")) {
    throw new Error(`Requirement string executable "${rawExecutable}" must be a plain basename.`)
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
    throw new Error(`Executable "${rawExecutable}" is not in the legacy migration allowlist.`)
  }

  const req: ValidationRequirement = { executable, args }
  validateCommandRequirement(req)

  return req
}
