/**
 * HOOK-04: Tool guard — blocks dangerous operations
 * Pattern matching on tool arguments to prevent destructive commands.
 * D-04: pure string.includes() matching, no path filtering, no regex/glob.
 * Also enforces architectural constraints from .codebase/CONSTRAINTS.md.
 * Default is ON; disable with FLOWDECK_TOOL_GUARD_ENABLED=off.
 */

const IS_ENABLED = () => process.env.FLOWDECK_TOOL_GUARD_ENABLED !== "off"

import { existsSync, readFileSync, realpathSync } from "fs"
import { join, resolve, normalize } from "path"
import { tmpdir } from "os"
import { tokenize } from "../services/shell-command-classifier"
import { codebaseDir } from "../tools/codebase-state"
import { resolveActiveTopic, topicPlanPath, readPlanningState } from "../tools/planning-state-lib"
import { isUiHeavyTask } from "../lib/task-routing"
import { loadFlowDeckConfig, resolveDesignFirstConfig } from "../config"
import type { FlowDeckConfig } from "../config/schema"
import { validateToolAccess } from "../services/agent-validator"
import { appendAuditEvent } from "../services/audit-log"
import { verifyAfterWrite } from "../services/verification-layer"
import { isFdxAvailable } from "../hooks/session-start"

const BLOCKED_PATTERNS = {
  read: [".env", ".pem", ".key", ".secret"],
  write: ["node_modules"],
  bash: ["rm -rf"],
}

function getFilePath(args: any): string | undefined {
  return (
    args?.filePath ??
    args?.path ??
    args?.file_path ??
    args?.file ??
    undefined
  )
}

function checkBlockedPath(filePath: string, patterns: string[]): string | null {
  for (const p of patterns) {
    if (filePath.includes(p)) {
      return `FLOWDECK: Writing to "${p}" is blocked.`
    }
  }
  return null
}

const sessionWrittenFiles = new Map<string, Set<string>>()

const WRITE_TOOLS = new Set([
  "write", "write_file",
  "edit", "edit_file",
  "patch", "apply_patch", "patch_file",
  "hash-edit",
  "str-replace", "str_replace", "str_replace_editor",
  "create", "create_file",
])

export function recordWrite(sessionID: string, filePath: string): void {
  const files = sessionWrittenFiles.get(sessionID) ?? new Set()
  files.add(filePath)
  sessionWrittenFiles.set(sessionID, files)
}

export function getWriteCount(sessionID: string): number {
  return sessionWrittenFiles.get(sessionID)?.size ?? 0
}

export function clearWriteCounter(sessionID: string): void {
  sessionWrittenFiles.delete(sessionID)
}

export function checkWriteLimit(
  sessionID: string,
  filePath: string,
  maxWrites: number,
): string | null {
  const files = sessionWrittenFiles.get(sessionID) ?? new Set()
  if (!files.has(filePath) && files.size >= maxWrites) {
    return (
      `[FlowDeck] Write limit reached: this agent has already modified ` +
      `${files.size} unique files (configured max: ${maxWrites}).\n` +
      `Modified so far: ${[...files].join(", ")}\n` +
      `Stop now and report back to the orchestrator with:\n` +
      `  1. What was completed\n` +
      `  2. What files remain\n` +
      `  3. Whether a second workstream is needed\n` +
      `Do NOT continue editing more files without orchestrator confirmation.`
    )
  }
  return null
}

export type BlockReason = string | null

/**
 * Check if a tool operation should be blocked.
 * Returns error message if blocked, null if allowed.
 */
/** Helper to check if a single target path is safely within an approved temporary root. */
function isSafeTemporaryTarget(rawTarget: string, workingDir: string): boolean {
  if (!rawTarget || rawTarget === "/" || rawTarget === "~" || rawTarget === ".") return false

  // Reject shell expansions, substitutions, or control characters in target
  const unsafeChars = ["$", "*", "?", "(", ")", "{", "}", "<", ">", "|", ";", "&"]
  if (unsafeChars.some(ch => rawTarget.includes(ch)) && !rawTarget.startsWith("$TMPDIR")) return false

  let expanded = rawTarget
  if (expanded.startsWith("$TMPDIR")) {
    const tmpEnv = process.env.TMPDIR || tmpdir()
    expanded = expanded.replace("$TMPDIR", tmpEnv)
  }

  const resolved = resolve(workingDir, expanded)
  const normalized = normalize(resolved)

  // Approved temporary roots
  const allowedRoots = [
    resolve(tmpdir()),
    resolve("/tmp"),
    resolve("/var/folders"),
    resolve("/private/var/folders"),
    process.env.TMPDIR ? resolve(process.env.TMPDIR) : null,
  ].filter(Boolean) as string[]

  for (const root of allowedRoots) {
    let normRoot = normalize(root)
    try {
      if (existsSync(normRoot)) normRoot = normalize(realpathSync(normRoot))
    } catch {}

    let checkTarget = normalized
    try {
      if (existsSync(normalized)) checkTarget = normalize(realpathSync(normalized))
    } catch {}

    // Target must be strictly inside the temp root, never the root itself
    if (
      normalized.startsWith(normalize(root) + "/") ||
      normalized.startsWith(normalize(root) + "\\") ||
      checkTarget.startsWith(normRoot + "/") ||
      checkTarget.startsWith(normRoot + "\\")
    ) {
      return true
    }
  }

  return false
}

/** Check whether an rm invocation is exclusively deleting temporary disposable fixtures. */
export function isSafeTemporaryRm(command: string, workingDir = process.cwd()): boolean {
  // Reject pipeline or redirect operators
  if (/[|&;><`$]/.test(command) && !command.includes("$TMPDIR")) return false

  const tokens = tokenize(command)
  if (tokens.length === 0) return false

  const head = tokens[0].toLowerCase()
  if (head !== "rm") return false

  const targets: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith("-")) continue
    targets.push(t)
  }

  if (targets.length === 0) return false

  for (const target of targets) {
    if (!isSafeTemporaryTarget(target, workingDir)) return false
  }

  return true
}

export function isBlocked(tool: string, args: any): BlockReason {
  const filePath = getFilePath(args)

  if (tool === "bash") {
    const cmd = args.command as string
    if (!cmd) return null
    for (const p of BLOCKED_PATTERNS.bash) {
      if (cmd.includes(p)) {
        if (p === "rm -rf") {
          if (isSafeTemporaryRm(cmd)) continue // Safely scoped to temp directory
        }
        return `FLOWDECK: Command containing "${p}" is blocked.`
      }
    }
    return null
  }

  if (tool === "read") {
    if (!filePath) return null
    for (const p of BLOCKED_PATTERNS.read) {
      if (filePath.includes(p)) {
        return `FLOWDECK: Access to "${p}" files is blocked.`
      }
    }
    return null
  }

  if (WRITE_TOOLS.has(tool)) {
    if (!filePath) return null
    const block = checkBlockedPath(filePath, BLOCKED_PATTERNS.write)
    if (block) return block
    return null
  }

  return null
}

/**
 * Architectural Constraint Guard.
 * Reads .codebase/CONSTRAINTS.md for forbidden path patterns and boundary rules.
 * Returns a block reason if the write/edit violates a constraint, null otherwise.
 *
 * CONSTRAINTS.md format (simple list of patterns in a ## Forbidden Paths section):
 *   ## Forbidden Paths
 *   - src/core/       # do not modify core directly
 *   - generated/      # auto-generated, do not edit manually
 */
export function checkArchConstraint(directory: string, filePath: string): BlockReason {
  const constraintsPath = join(codebaseDir(directory), "CONSTRAINTS.md")
  if (!existsSync(constraintsPath)) return null
  try {
    const content = readFileSync(constraintsPath, "utf-8")
    const match = content.match(/## Forbidden Paths\n([\s\S]*?)(?:\n##|$)/)
    if (!match) return null
    for (const line of match[1].split("\n")) {
      const pattern = line.replace(/^-\s*/, "").split("#")[0].trim()
      if (pattern && filePath.includes(pattern)) {
        return `FLOWDECK [arch-constraint]: editing "${pattern}" is forbidden by .codebase/CONSTRAINTS.md`
      }
    }
  } catch { /* skip */ }
  return null
}

/**
 * Phase Enforcement Guard.
 * Prevents writing to the codebase during planning phases.
 */
export function checkPhaseEnforcement(directory: string): BlockReason {
  try {
    const state = readPlanningState(directory)
    const flowdeckConfig = resolveDesignFirstConfig(loadFlowDeckConfig(directory))
    // Phases: 1=task, 2=review, 3=execute, 4=verify
    // Block write/edit if in phase 1 or 2
    if (state.phase > 0 && state.phase < 3) {
      if (state.plan_confirmed) return null
      return `FLOWDECK [phase-gate]: writing to codebase is blocked in phase ${state.phase} (${state.phase === 1 ? "task" : "review"}). Complete /fd-task and /fd-review to enter the execute phase.`
    }
    if (flowdeckConfig.enabled && flowdeckConfig.requireApprovalBeforeImplementation && isUiDesignApprovalRequired(directory)) {
      if (flowdeckConfig.enforcement === "advisory") {
        return `FLOWDECK [design-gate]: advisory design-first mode detected missing approval. Approve the design in /fd-review or set design_override=true in STATE.md.`
      }
      return `FLOWDECK [design-gate]: UI-heavy task requires approved design handoff before implementation. Capture the design in architecture.md via /fd-task, approve it in /fd-review so design_stage=handoff_complete + design_approved=true, or set explicit design_override with reason.`
    }
  } catch {
    // If STATE.md doesn't exist or is invalid, don't block
  }
  return null
}

function isUiDesignApprovalRequired(directory: string): boolean {
  const state = readPlanningState(directory)
  if (state.design_override && state.design_override_reason && state.design_override_reason.trim().length > 0) return false
  if (state.requires_design_first) {
    return !(state.design_stage === "handoff_complete" && state.design_approved)
  }
  if (state.task_type && isUiHeavyTask(state.task_type)) {
    return !(state.design_stage === "handoff_complete" && state.design_approved)
  }
  const topic = resolveActiveTopic(directory, state)
  if (!topic) return false
  const planPath = topicPlanPath(directory, topic)
  if (!existsSync(planPath)) return false
  const planContent = readFileSync(planPath, "utf-8")
  if (!isUiHeavyTask(planContent)) return false
  return !(state.design_stage === "handoff_complete" && state.design_approved)
}

/**
 * TDD Enforcement Guard.
 * Blocks production code writes when the TDD stage is still 'behavior'
 * and no failing test exists yet for the current step.
 *
 * Exemptions:
 *   - workflow class is "trivial"
 *   - file is a test file (.test., .spec., _test., /tests/, /test/, /__tests__/, /spec/)
 *   - file is config, migration, DTO, constants, type definitions
 *   - STATE.md has no TDD state (TDD not active)
 */
function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return (
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("_test.") ||
    lower.includes("/tests/") ||
    lower.includes("/test/") ||
    lower.includes("/__tests__/") ||
    lower.includes("/spec/")
  )
}

function isExemptFromTDD(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  return (
    lower.includes("config") ||
    lower.includes("migration") ||
    lower.includes("dto") ||
    lower.includes("constants") ||
    lower.includes("types.") ||
    lower.endsWith(".d.ts")
  )
}

export function checkTDDEnforcement(directory: string, filePath: string): BlockReason {
  try {
    const state = readPlanningState(directory)
    // TDD not active — no enforcement
    if (!state.tdd) return null
    // Trivial workflow is exempt
    if (state.workflowClass === "trivial") return null
    // Only enforce when stage is 'behavior' (before RED)
    if (state.tdd.stage !== "behavior") return null
    // Test files are allowed (that's what RED writes)
    if (isTestFile(filePath)) return null
    // Exempt file types
    if (isExemptFromTDD(filePath)) return null
    return (
      `[TDD Guard] Cannot write production code before a failing test exists.\n` +
      `Current stage: behavior\n` +
      `Required: write a failing test first, then implement.`
    )
  } catch {
    // If STATE.md doesn't exist or is invalid, don't block
  }
  return null
}

export interface ToolGuardDecision {
  tool: string
  allowed: boolean
  reason: string | null
  checks: string[]
}

const recentDecisions: ToolGuardDecision[] = []
const MAX_DECISIONS = 50

function logDecision(ctx: ToolGuardContext, decision: ToolGuardDecision, input: { sessionID?: string; agent?: string; tool?: string }): void {
  recentDecisions.push(decision)
  if (recentDecisions.length > MAX_DECISIONS) {
    recentDecisions.shift()
  }
  appendAuditEvent(ctx.directory, {
    kind: decision.allowed ? "guard.allow" : "guard.block",
    session_id: input.sessionID,
    agent: input.agent,
    tool: decision.tool,
    decision: decision.allowed ? "allow" : "block",
    reason: decision.reason ?? undefined,
    details: { checks: decision.checks },
  })
}

export function getRecentToolGuardDecisions(): ToolGuardDecision[] {
  return recentDecisions.slice()
}

export function clearToolGuardDecisions(): void {
  recentDecisions.length = 0
}

interface ToolGuardContext {
  directory: string
  agent?: string
  session?: { agent?: string }
}

interface ToolGuardInput {
  tool: string
  sessionID?: string
  name?: string
  args?: any
  agent?: string
}

/**
 * Resolve the agent name from realistic OpenCode SDK payload locations.
 * The SDK `tool.execute.before` payload does not include `input.agent`;
 * the agent is supplied on the surrounding context/session metadata.
 */
function resolveAgentName(ctx: ToolGuardContext, input: ToolGuardInput): string | undefined {
  return ctx.agent ?? ctx.session?.agent ?? input.agent ?? "orchestrator"
}

/**
 * HOOK-04: Tool guard hook
 * Called on tool.execute.before for all tools.
 * Blocks dangerous read/write/bash/edit operations, arch-constraint violations, and premature implementation.
 */
export async function toolGuardHook(
  ctx: ToolGuardContext,
  input: ToolGuardInput,
  output: { args: any }
): Promise<void> {
  const toolName = input.tool ?? input.name ?? ""
  const sessionID = input.sessionID ?? ""
  const agentName = resolveAgentName(ctx, input)
  const decision: ToolGuardDecision = { tool: toolName, allowed: true, reason: null, checks: [] }

  if (!IS_ENABLED()) {
    decision.allowed = true
    decision.reason = "tool guard disabled via FLOWDECK_TOOL_GUARD_ENABLED=off"
    logDecision(ctx, decision, { sessionID, agent: agentName, tool: toolName })
    return
  }

  const args = output.args ?? input.args ?? {}

  // HOOK-04-DD: Delegation-depth guard — subagents cannot spawn nested subagents.
  if (toolName === "task") {
    const config: FlowDeckConfig = loadFlowDeckConfig(ctx.directory)
    const maxDepth = config.maxDelegationDepth ?? 1
    if (agentName !== "orchestrator" && agentName !== "heidi") {
      const msg = `[FlowDeck Delegation] Delegation depth limit reached (configured max: ${maxDepth}). Subagent "${agentName}" cannot spawn nested subagents.`
      decision.allowed = false
      decision.reason = msg
      decision.checks.push("delegation-depth-limit")
      logDecision(ctx, decision, { sessionID, agent: agentName, tool: toolName })
      throw new Error(msg)
    }
  }

  // HOOK-04-WL: Write-limit guard — cap unique files modified per agent session.
  if (WRITE_TOOLS.has(toolName)) {
    const filePath = getFilePath(args) ?? ""
    if (filePath) {
      const config: FlowDeckConfig = loadFlowDeckConfig(ctx.directory)
      const maxWrites = config.maxWritesPerAgent ?? 100
      if (maxWrites > 0) {
        const limitMsg = checkWriteLimit(sessionID, filePath, maxWrites)
        if (limitMsg) {
          decision.allowed = false
          decision.reason = limitMsg
          decision.checks.push("write-limit")
          logDecision(ctx, decision, { sessionID, agent: agentName, tool: toolName })
          throw new Error(limitMsg)
        }
      }
    }
  }

  // Check known dangerous tools including edit, patch, hash-edit, create, str_replace.
  if (toolName !== "bash" && toolName !== "read" && !WRITE_TOOLS.has(toolName)) {
    decision.checks.push("no-op")
    logDecision(ctx, decision, { sessionID, agent: agentName, tool: toolName })
    return
  }

  const blockReason = isBlocked(toolName, args)
  if (blockReason) {
    decision.allowed = false
    decision.reason = blockReason
    decision.checks.push("dangerous-pattern")
    logDecision(ctx, decision, { sessionID, agent: agentName, tool: toolName })
    throw new Error(blockReason)
  }

  // Worker agent tool-permission enforcement (agent resolved from context/session/input).
  if (agentName && typeof agentName === "string") {
    decision.checks.push("agent-contract")
    const validation = validateToolAccess(ctx.directory, agentName, toolName)
    // Validator enforcement: check final action, not raw violation severity.
    // 'off' never blocks, 'advisory' warns, 'strict' blocks.
    if (validation.action === "block") {
      const msg = validation.message ?? `FLOWDECK: Agent ${agentName} is not permitted to use ${toolName}`
      decision.allowed = false
      decision.reason = msg
      logDecision(ctx, decision, { sessionID, agent: agentName, tool: toolName })
      throw new Error(msg)
    } else if (validation.action === "warn") {
      decision.checks.push("agent-contract-warning")
    }
  }

  // Phase & Arch-constraint check on all write/edit/patch/create tools.
  if (WRITE_TOOLS.has(toolName)) {
    decision.checks.push("phase-gate")
    const phaseBlock = checkPhaseEnforcement(ctx.directory)
    if (phaseBlock) {
      decision.allowed = false
      decision.reason = phaseBlock
      logDecision(ctx, decision, { sessionID, agent: agentName, tool: toolName })
      throw new Error(phaseBlock)
    }

    decision.checks.push("arch-constraint")
    const filePath = getFilePath(args) ?? ""
    if (filePath) {
      const constraintBlock = checkArchConstraint(ctx.directory, filePath)
      if (constraintBlock) {
        decision.allowed = false
        decision.reason = constraintBlock
        logDecision(ctx, decision, { sessionID, agent: agentName, tool: toolName })
        throw new Error(constraintBlock)
      }

      decision.checks.push("tdd-enforcement")
      const tddBlock = checkTDDEnforcement(ctx.directory, filePath)
      if (tddBlock) {
        decision.allowed = false
        decision.reason = tddBlock
        logDecision(ctx, decision, { sessionID, agent: agentName, tool: toolName })
        throw new Error(tddBlock)
      }
    }
  }

  // FDX redirect: silently rewrite native read → fdx-read instead of throwing
  // an advisory error that causes infinite retry loops (observed: 488 wasted turns).
  if (tryFdxRedirect(toolName, output.args ?? {})) {
    decision.checks.push("fdx-redirect-rewrite")
    // Allow the call to proceed; output.args now carries fdx-compatible fields.
  }

  decision.checks.push("allowed")
  logDecision(ctx, decision, { sessionID, agent: agentName, tool: toolName })
}

/**
 * Execute post-write lifecycle actions AFTER a write tool has executed successfully.
 * Invoked from tool.execute.after.
 */
export function executePostWriteHook(
  directory: string,
  sessionID: string,
  agentName: string | undefined,
  toolName: string,
  args: any
): void {
  if (!WRITE_TOOLS.has(toolName)) return
  const filePath = getFilePath(args) ?? ""
  if (!filePath) return

  // Record the write only AFTER successful execution
  recordWrite(sessionID, filePath)

  // Verify the updated file after successful write
  verifyAfterWrite(directory, {
    sessionID,
    agent: agentName,
    tool: toolName,
    filePath,
  })

  appendAuditEvent(directory, {
    kind: "verification.event",
    session_id: sessionID,
    agent: agentName,
    tool: toolName,
    decision: "allow",
    details: { filePath },
  })
}

const NATIVE_READ_TOOLS = new Set(["read_file", "read", "grep", "glob", "find"])

/**
 * FDX Redirect Guard.
 * When fdx is available and FLOWDECK_ENFORCE_FDX_REDIRECT=true, silently
 * rewrites native read/search tool args so the operation succeeds via fdx
 * instead of throwing an advisory error that causes infinite retry loops.
 *
 * Returns true if args were rewritten (caller should allow the call),
 * false if no rewrite was possible or fdx is unavailable.
 *
 * Disable for tests with FLOWDECK_DISABLE_FDX_REDIRECT=true.
 */
export interface FdxExecutionRoute {
  targetTool: string
  executed: boolean
  output?: string
  fallbackUsed?: boolean
  error?: string
}

/**
 * Authoritative FDX Execution Router.
 * When FLOWDECK_ENFORCE_FDX_REDIRECT=true and FDX is available, genuinely executes
 * native read / read_file requests through the fdxReadTool path rather than only
 * tagging dummy metadata.
 */
export async function executeFdxRedirect(
  toolName: string,
  args: Record<string, unknown>,
  context?: { directory?: string; sessionID?: string; agent?: string }
): Promise<FdxExecutionRoute | null> {
  if (!NATIVE_READ_TOOLS.has(toolName)) return null
  if (!isFdxAvailable()) return null
  if (process.env.FLOWDECK_DISABLE_FDX_REDIRECT === "true") return null
  if (process.env.FLOWDECK_ENFORCE_FDX_REDIRECT !== "true") return null

  if (toolName === "read" || toolName === "read_file") {
    const rawPath =
      (args.filePath as string | undefined) ??
      (args.file_path as string | undefined) ??
      (args.path as string | undefined) ??
      (args.file as string | undefined)

    if (!rawPath) return null

    const resolvedFile = rawPath
    const mode = (args.mode as "auto" | "raw" | "prototype" | "deep" | undefined) ?? "auto"
    const limit = typeof args.limit === "number" ? args.limit : undefined
    const offset = typeof args.offset === "number" ? args.offset : undefined
    const symbol = typeof args.symbol === "string" ? args.symbol : undefined

    try {
      const { fdxReadTool } = await import("../tools/fdx")
      const toolCtx = context ? ({ directory: context.directory, sessionID: context.sessionID } as any) : undefined
      const rawResult = await (fdxReadTool as any).execute(
        {
          file: resolvedFile,
          mode,
          limit,
          offset,
          symbol,
        },
        toolCtx
      )
      const output = typeof rawResult === "string" ? rawResult : rawResult?.output ?? String(rawResult)
      return {
        targetTool: "fdx-read",
        executed: true,
        output,
      }
    } catch (err: any) {
      // Apply exactly one bounded documented fallback to native read on genuine FDX failure
      try {
        const { nativeReadFallback } = await import("../tools/fdx-shared")
        const fallbackResult = nativeReadFallback(resolvedFile, limit, offset, context?.directory)
        return {
          targetTool: "fdx-read",
          executed: true,
          fallbackUsed: true,
          output: fallbackResult,
        }
      } catch (fallbackErr: any) {
        return {
          targetTool: "fdx-read",
          executed: false,
          error: fallbackErr.message || err.message,
        }
      }
    }
  }

  return null
}

export function tryFdxRedirect(toolName: string, outputArgs: Record<string, unknown>): boolean {
  if (!NATIVE_READ_TOOLS.has(toolName)) return false
  if (!isFdxAvailable()) return false
  if (process.env.FLOWDECK_DISABLE_FDX_REDIRECT === "true") return false
  if (process.env.FLOWDECK_ENFORCE_FDX_REDIRECT !== "true") return false
  if (toolName === "read" || toolName === "read_file") {
    const filePath =
      (outputArgs.filePath as string | undefined) ??
      (outputArgs.file_path as string | undefined) ??
      (outputArgs.path as string | undefined) ??
      (outputArgs.file as string | undefined)
    if (filePath) {
      const mode = outputArgs.mode ?? "auto"
      outputArgs._fdxRedirect = true
      outputArgs.mode = mode
      outputArgs.file = filePath
    }
    return true
  }
  return false
}

/**
 * @deprecated Use tryFdxRedirect instead. Kept for test compatibility.
 * Returns an advisory string only when silent rewrite is impossible.
 */
export function checkFdxRedirect(toolName: string): BlockReason {
  if (!NATIVE_READ_TOOLS.has(toolName)) return null
  if (!isFdxAvailable()) return null
  if (process.env.FLOWDECK_DISABLE_FDX_REDIRECT === "true") return null
  if (process.env.FLOWDECK_ENFORCE_FDX_REDIRECT !== "true") return null
  return null  // Silent: tryFdxRedirect handles the rewrite; no advisory thrown.
}
