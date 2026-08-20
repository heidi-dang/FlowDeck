/**
 * Orchestrator Guard Hook (FlowDeck v2.2.7)
 *
 * Implements the v2.2.7 Heidi Autonomous Developer & Approval Authorization Model:
 *   - Heidi operates as a trusted autonomous developer inside the active workspace.
 *   - Normal repository development, file edits, test runners, local git operations,
 *     and safe command substitutions are permitted directly (ALLOW).
 *   - Operations crossing sensitive, external, privileged, or destructive trust
 *     boundaries (git push, npm publish, sudo, .env reads, rm -rf /...) require
 *     explicit one-shot User Approval (APPROVAL_REQUIRED -> WAITING_FOR_APPROVAL).
 *   - Invalid or unsupported operations are rejected (DENY_INVALID).
 *
 * To disable: set FLOWDECK_ORCHESTRATOR_GUARD=off in the environment.
 * Default is ON.
 */

import type { AgentRoute } from "../agents/routing"
import { evaluateShellAuthorization } from "../services/shell-command-classifier"
import { isHeidiAgent } from "../services/canonical-registry"
import { RecoverableFlowDeckBlockError } from "../services/recoverable-block"
import {
  orchestratorGuardStrategyCircuit,
  normalizeGuardFingerprint,
} from "../services/orchestrator-guard-strategy-circuit"
import { flowDeckApprovalRegistry } from "../services/approval-service"

const DISABLED = process.env.FLOWDECK_ORCHESTRATOR_GUARD === "off"

export interface OrchestratorRoutingHint {
  runId: string
  workflowClass: string
  isTrivialChat: boolean
  toolFamily: { family: string; mcp: string | null; preferred: boolean } | null
  tokenOptimizationActive: boolean
  readiness: { statePresent: boolean; stateFresh: boolean; codebaseIndexPresent: boolean; codegraphReady: boolean }
  routeSignals: string[]
}

const BLOCKED_TOOLS = new Set([
  "write_file",
  "write",
  "create_file",
  "create",
  "edit_file",
  "edit",
  "patch",
  "apply_patch",
  "str_replace_editor",
  "str_replace",
  "python",
  "run_python",
  "js",
  "run_js",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "cargo",
  "go",
  "make",
  "cmake",
  "docker",
  "kubectl",
  "terraform",
  "pulumi",
  "bash",
  "run_bash",
  "run-bash",
  "execute",
  "run_command",
  "run-command",
  "terminal",
  "shell",
])

const SHELL_TOOLS = new Set([
  "bash",
  "runbash",
  "execute",
  "runcommand",
  "terminal",
  "shell",
])

const ALWAYS_ALLOWED = new Set([
  "read",
  "read_file",
  "view",
  "search",
  "grep",
  "glob",
  "planning-state",
  "codebase-state",
  "repo-memory",
  "codegraph",
  "codegraph-search",
  "codegraph-node",
  "codegraph-explore",
  "codegraph-context",
  "codegraph-callers",
  "codegraph-callees",
  "codegraph-impact",
  "codegraph-trace",
  "codegraph-files",
  "codegraph-status",
  "load-rules",
  "list-rules",
  "review-lessons",
  "capture-lesson",
  "task",
  "fdx-read",
  "fdx-search",
  "fdx-grep",
  "fdx-outline",
  "fdx-batch",
  "fdx-impact",
  "fdx-diff",
  "fdx-git",
  "fdx-ls",
  "fdx-tree",
  "skill",
  "codebase-index",
  "context7",
  "websearch",
  "exa",
  "grep_app",
  "github",
  "memory",
  "sequentialThinking",
  "sequential-thinking",
  "token-optimizer",
  "tokenOptimizer",
])

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "")
}

function isBlocked(name: string): boolean {
  const norm = normalizeToolName(name)
  for (const b of BLOCKED_TOOLS) {
    if (norm === normalizeToolName(b)) return true
  }
  return false
}

function isAlwaysAllowed(name: string): boolean {
  const norm = normalizeToolName(name)
  for (const a of ALWAYS_ALLOWED) {
    if (norm === normalizeToolName(a)) return true
  }
  return false
}

function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(normalizeToolName(name))
}

function readCommandArg(args: unknown): string | null {
  if (!args || typeof args !== "object") return null
  const obj = args as Record<string, unknown>
  for (const key of ["command", "cmd", "script"]) {
    const v = obj[key]
    if (typeof v === "string" && v.trim().length > 0) return v
  }
  return null
}

const MULTIPLEXED_TOOLS = new Set(["codegraph", "memory"])

const CODEGRAPH_READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  "check",
  "status",
  "query",
  "search",
  "context",
  "explore",
  "files",
  "file_list",
  "file",
  "node",
  "callers",
  "callees",
  "impact",
  "trace",
  "dependencies",
  "dependents",
  "summary",
  "read",
  "get",
  "list",
  "find_references",
  "find_usages",
  "definitions",
])

const MEMORY_READ_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  "read_graph",
  "search_nodes",
  "open_nodes",
  "get_entities",
  "get_relations",
  "search",
  "query",
  "read",
  "get",
  "list",
  "view",
  "status",
])

function getMultiplexedAction(args: unknown): string | null {
  if (!args || typeof args !== "object") return null
  const obj = args as Record<string, unknown>
  for (const key of ["action", "mode", "operation", "command"]) {
    const v = obj[key]
    if (typeof v === "string" && v.trim().length > 0) {
      return v.trim().toLowerCase()
    }
  }
  return null
}

function isReadOnlyMultiplexedAction(toolName: string, args: unknown): boolean | null {
  const norm = normalizeToolName(toolName)
  if (!MULTIPLEXED_TOOLS.has(norm)) return null
  const action = getMultiplexedAction(args)
  if (action === null) return false
  if (norm === "codegraph") return CODEGRAPH_READ_ONLY_ACTIONS.has(action)
  if (norm === "memory") return MEMORY_READ_ONLY_ACTIONS.has(action)
  return false
}

function extractSessionId(event: {
  sessionID?: string
  sessionId?: string
  properties?: unknown
  event?: unknown
}): string | null {
  if (typeof event.sessionID === "string" && event.sessionID.length > 0) return event.sessionID
  if (typeof event.sessionId === "string" && event.sessionId.length > 0) return event.sessionId
  const props = event.properties as Record<string, unknown> | undefined
  if (props) {
    if (typeof props.sessionID === "string" && props.sessionID.length > 0) return props.sessionID
    if (typeof props.sessionId === "string" && props.sessionId.length > 0) return props.sessionId
    const info = props.info as Record<string, unknown> | undefined
    if (info) {
      if (typeof info.sessionID === "string" && info.sessionID.length > 0) return info.sessionID
      if (typeof info.id === "string" && info.id.length > 0) return info.id
    }
  }
  return null
}

function extractParentSessionId(event: {
  properties?: unknown
}): string | null {
  const props = event.properties as Record<string, unknown> | undefined
  if (!props) return null
  if (typeof props.parentID === "string" && props.parentID.length > 0) return props.parentID
  const info = props.info as Record<string, unknown> | undefined
  if (info && typeof info.parentID === "string" && info.parentID.length > 0) return info.parentID
  return null
}

export class OrchestratorGuard {
  private primarySessionId: string | null = null
  private lastRoutingHint: OrchestratorRoutingHint | undefined = undefined
  private readonly routes: AgentRoute[]

  constructor(options?: { routes?: AgentRoute[] }) {
    this.routes = options?.routes ?? []
  }

  private buildRoutingOptions(): string {
    return this.routes
      .map((r) => `  @${r.name.padEnd(22)} — ${r.description}`)
      .join("\n")
  }

  onEvent(event: { type?: string; properties?: unknown; event?: unknown; sessionID?: string; sessionId?: string }): void {
    const eventType = event.type ?? ""
    if (eventType === "session.deleted") {
      const deletedId = extractSessionId(event)
      if (deletedId && deletedId === this.primarySessionId) {
        this.primarySessionId = null
      }
      return
    }
    if (eventType !== "session.created" && eventType !== "session.started") return
    if (this.primarySessionId !== null) return

    const id = extractSessionId(event)
    if (!id) return
    if (extractParentSessionId(event)) return
    this.primarySessionId = id
  }

  check(sessionId: string, toolName: string, args?: unknown, agentName?: string): void {
    if (DISABLED) return
    if (this.primarySessionId !== null && sessionId !== this.primarySessionId) return

    // Non-Heidi specialist agents are governed by their respective specialist bounds
    if (agentName !== undefined && !isHeidiAgent(agentName)) return

    const effectiveAgent = agentName ?? "heidi"
    const isHeidi = isHeidiAgent(effectiveAgent)

    if (isHeidi) {
      if (isShellTool(toolName)) {
        const cmd = readCommandArg(args)
        if (cmd === null || cmd.trim() === "") {
          throw new RecoverableFlowDeckBlockError({
            subsystem: "orchestrator_guard",
            code: "ORCHESTRATOR_GUARD_MISSING_ARG",
            tool: toolName,
            sessionID: sessionId,
            agent: effectiveAgent,
            reason: "[Orchestrator Guard] Shell call with no inspectable command string supplied in args.",
            recoverable: true,
          })
        }

        const cwd = (args && typeof args === "object" && typeof (args as Record<string, unknown>).cwd === "string")
          ? (args as Record<string, unknown>).cwd as string
          : process.cwd()

        // Authoritative v2.2.7 Authorization Evaluation
        const auth = evaluateShellAuthorization(cmd, { workingDir: cwd })

        // 1. ALLOW -> Autonomous execution inside workspace
        if (auth.decision === "ALLOW") {
          orchestratorGuardStrategyCircuit.recordAllowedProgress(sessionId)
          return
        }

        // 2. APPROVAL_REQUIRED -> Check one-shot approval registry
        if (auth.decision === "APPROVAL_REQUIRED") {
          const fingerprint = normalizeGuardFingerprint(toolName, args, cwd)

          // Check if already approved by user
          if (flowDeckApprovalRegistry.hasApproved(sessionId, fingerprint)) {
            // Consume one-shot approval and proceed
            flowDeckApprovalRegistry.consume(sessionId, fingerprint)
            orchestratorGuardStrategyCircuit.recordAllowedProgress(sessionId)
            return
          }

          // Not approved yet -> register pending request and pause
          const approvalReq = flowDeckApprovalRegistry.requestApproval({
            sessionId,
            tool: toolName,
            normalizedAction: auth.normalizedAction,
            cwd,
            workspace: cwd,
            riskLevel: auth.riskLevel,
            riskCategory: auth.riskCategory,
            reason: auth.reason,
            scope: auth.scope,
            target: auth.target,
            exactFingerprint: fingerprint,
          })

          const rawCode =
            auth.riskCategory === "sensitive_data"
              ? "ORCHESTRATOR_GUARD_SENSITIVE_READ"
              : "ORCHESTRATOR_GUARD_RISKY_SHELL"

          const circuit = orchestratorGuardStrategyCircuit.evaluateBlock({
            sessionID: sessionId ?? "",
            toolName,
            input: args,
            reasonCode: rawCode,
            reasonText: auth.reason,
            suggestedActions: [
              `Grant approval for '${auth.normalizedAction}' in the FlowDeck UI`,
              "Replan using an alternative local workspace operation that does not cross trust boundaries",
            ],
            isApprovalRequired: true,
          })

          const cardText = flowDeckApprovalRegistry.formatApprovalCard(approvalReq)

          throw new RecoverableFlowDeckBlockError({
            subsystem: "orchestrator_guard",
            code: rawCode,
            tool: toolName,
            sessionID: sessionId,
            agent: effectiveAgent,
            reason: cardText + "\n\n" + circuit.message,
            recoverable: true,
            terminal: false,
            requiresHuman: true,
            suggestedActions: [
              `Authorize with approval ID: ${approvalReq.approval_id}`,
              "Wait for user approval in UI or choose an alternative workspace-local tool",
            ],
            details: {
              approval: approvalReq,
              fingerprint,
              risk_level: auth.riskLevel,
              risk_category: auth.riskCategory,
              status: "WAITING_FOR_APPROVAL",
            },
          })
        }

        // 3. DENY_INVALID -> Technically malformed or unsupported
        const circuit = orchestratorGuardStrategyCircuit.evaluateBlock({
          sessionID: sessionId ?? "",
          toolName,
          input: args,
          reasonCode: "ORCHESTRATOR_GUARD_DENY_INVALID",
          reasonText: auth.reason,
        })

        throw new RecoverableFlowDeckBlockError({
          subsystem: "orchestrator_guard",
          code: "ORCHESTRATOR_GUARD_DENY_INVALID",
          tool: toolName,
          sessionID: sessionId,
          agent: effectiveAgent,
          reason: circuit.message + "\n\nReason: " + auth.reason,
          recoverable: false,
          terminal: true,
        })
      }

      // Non-shell file and analysis tools: direct execution permitted
      return
    }
  }

  getRoutingHint(sessionId: string): OrchestratorRoutingHint | undefined {
    if (this.primarySessionId === null) return undefined
    if (sessionId !== this.primarySessionId) return undefined
    return this.lastRoutingHint
  }

  _getRoutingOptionsForTest(): string {
    return this.buildRoutingOptions()
  }

  _setPrimarySessionIdForTest(sessionId: string | null): void {
    this.primarySessionId = sessionId
  }

  _setRoutingHintForTest(hint: OrchestratorRoutingHint | undefined): void {
    this.lastRoutingHint = hint
  }

  _isBlockedForTest(name: string): boolean {
    return isBlocked(name)
  }

  _isAllowedForTest(name: string): boolean {
    return isAlwaysAllowed(name)
  }

  _isReadOnlyMultiplexedForTest(name: string, args: unknown): boolean | null {
    return isReadOnlyMultiplexedAction(name, args)
  }
}
