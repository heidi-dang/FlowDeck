/**
 * FlowDeck Plugin Entry Point
 *
 * Integrates all subsystems into the OpenCode plugin lifecycle:
 * - Agent registry (from canonical registry)
 * - Governance wiring (validator, supervisor, loop detector, audit, verification)
 * - Tool permissions (orchestrator guard, tool guard, guard rails)
 * - State management (session start/end, checkpoint, recovery)
 * - FDX tools with native fallbacks
 * - MCP server configurations
 * - Skills and commands registration
 * - Doctor diagnostics
 */

import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, readFileSync, readdirSync } from "fs"
import { basename, dirname, join } from "path"
import { fileURLToPath } from "url"

import {
  buildSelectionDiagnostics,
  detectProjectLanguages,
  getStartupRulePaths,
  selectRulePaths,
} from "./services/lazy-rule-loader"
import { LoopDetector } from "./services/loop-detector"

import { getAgentConfigs, getAgentRoutes } from "./agents/index"
import { loadFlowDeckConfig, resolveAgentModels, type FlowDeckConfig } from "./config/index"
import { guardRailsHook } from "./hooks/guard-rails"
import { OrchestratorGuard } from "./hooks/orchestrator-guard-hook"
import { sessionStartHook } from "./hooks/session-start"
import { sessionEventsHook } from "./hooks/session-events"
import { executePostWriteHook, clearWriteCounter, toolGuardHook } from "./hooks/tool-guard"
import { buildFlowDeckMcpsWithMeta } from "./mcp/index"
import { captureLessonTool, reviewLessonsTool } from "./tools/capture-lesson"
import { codegraphTool } from "./tools/codegraph-tool"
import { codebaseStateTool } from "./tools/codebase-state"
import { doctorTool } from "./tools/doctor"
import { fdxValidateTool } from "./tools/fdx-validate"
import { fdxWorktreeTool } from "./tools/fdx-worktree"
import {
  fdxBatchTool,
  fdxContextTool,
  fdxDecisionsTool,
  fdxDiffTool,
  fdxGitTool,
  fdxGrepTool,
  fdxImpactTool,
  fdxLintTool,
  fdxLsTool,
  fdxOutlineTool,
  fdxReadTool,
  fdxSearchTool,
  fdxTestTool,
  fdxTreeTool,
  setActiveProjectDir,
} from "./tools/fdx"
import { hashEditTool } from "./tools/hash-edit"
import { loadRulesTool, listRulesTool } from "./tools/load-rules"
import { planningStateTool } from "./tools/planning-state"
import { repoMemoryTool } from "./tools/repo-memory"
import { debugLogsTool } from "./tools/debug-logs"

// ─── Governance integration ────────────────────────────────────────────────
import {
  evaluateGovernanceToolCheck,
  recordRecoveryAudit,
  executeVerifiedPostWrite,
  generateScorecard,
  validateDelegationDepth,
  resolveGovernanceMode,
} from "./services/governance-wiring"
import { runSupervisorReview, shouldProceed, resolveSupervisorConfig } from "./services/supervisor-binding"
import { appendAuditEvent } from "./services/audit-log"
import { isSpecialistAgent, getAllAgentIds } from "./services/canonical-registry"

// ─── Session budget tracking ──────────────────────────────────────────────
/** Tracks tool call count per session ID. */
const sessionToolCalls = new Map<string, number>()
/** Tracks retry count per session ID. */
const sessionRetries = new Map<string, number>()
/** Tracks delegation (task tool use) count per session ID. */
const sessionDelegations = new Map<string, number>()
/** Tracks total blocks per session. */
const sessionBlocks = new Map<string, number>()
/** Tracks total warnings per session. */
const sessionWarnings = new Map<string, number>()
/** Tracks session start timestamps. */
const sessionStartTimes = new Map<string, number>()
/** Tracks files changed per session. */
const sessionFilesChanged = new Map<string, Set<string>>()

const __dir = dirname(fileURLToPath(import.meta.url))

/** Select FlowDeck rule paths for cfg.instructions injection. */
function lazyLoadRulePaths(projectRoot: string): { paths: string[]; diagnostics: string } {
  const rulesDir = join(__dir, "..", "src", "rules")
  if (!existsSync(rulesDir)) return { paths: [], diagnostics: "[LazyRuleLoader] rules directory not found" }
  const detected = detectProjectLanguages(projectRoot)
  const paths = getStartupRulePaths(rulesDir, detected)
  const selection = selectRulePaths(rulesDir, { languages: detected, projectRoot })
  return { paths, diagnostics: buildSelectionDiagnostics(selection, { languages: detected, projectRoot }) }
}

/** Load FlowDeck slash commands from src/commands/*.md. */
function loadCommands(): Record<string, { description?: string; template: string }> {
  const dir = join(__dir, "..", "src", "commands")
  if (!existsSync(dir)) return {}
  const out: Record<string, { description?: string; template: string }> = {}
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue
      const raw = readFileSync(join(dir, file), "utf-8")
      const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
      const template = fm ? fm[2].trim() : raw
      const desc = fm?.[1].match(/^description:\s*(.+)$/m)?.[1].trim()
      out[basename(file, ".md")] = desc ? { description: desc, template } : { template }
    }
  } catch { /* ignore read errors */ }
  return out
}

const specialistAgentSet = new Set(getAllAgentIds().filter(id => isSpecialistAgent(id)))

const plugin: Plugin = async ({ directory, client }) => {
  // ─── Structured logging with levels and correlation ─────────────────────
  let logSequence = 0
  type LogLevel = "debug" | "info" | "warn" | "error"
  const appLog = (msg: string, level: LogLevel = "info", sessionID?: string): Promise<void> => {
    const correlationId = sessionID ? `${sessionID}:${++logSequence}` : `anon:${++logSequence}`
    return client.app.log({
      body: {
        service: "flowdeck",
        level,
        message: msg,
        extra: { correlationId, timestamp: new Date().toISOString() },
      },
    }).then(() => undefined).catch(() => {})
  }

  // Set active project directory for FDX native fallback functions
  setActiveProjectDir(directory)

  let flowdeckConfig: FlowDeckConfig = loadFlowDeckConfig(directory)
  const orchestratorGuard = new OrchestratorGuard({ routes: getAgentRoutes() })
  const loopDetector = new LoopDetector(flowdeckConfig.governance?.loopDetection, appLog)

  // Resolve budget limits from config (with safe defaults)
  const maxToolCalls = flowdeckConfig.governance?.delegationBudget?.maxToolCalls ?? 200
  const maxRetries = flowdeckConfig.governance?.delegationBudget?.maxSameStepRetries ?? 3
  const maxDelegations = flowdeckConfig.governance?.delegationBudget?.maxDelegations ?? 20
  const maxDepth = flowdeckConfig.governance?.delegationBudget?.maxDepth ?? 1

  const { mcps } = buildFlowDeckMcpsWithMeta()

  return {
    config: async (cfg: Record<string, unknown>) => {
      if (!(cfg as { default_agent?: string }).default_agent) {
        (cfg as { default_agent?: string }).default_agent = "heidi"
      }

      flowdeckConfig = loadFlowDeckConfig(directory)
      const resolvedAgents = getAgentConfigs(resolveAgentModels(flowdeckConfig))

      if (!cfg.agent) {
        cfg.agent = { ...resolvedAgents }
      } else {
        const existing = cfg.agent as Record<string, unknown>
        for (const [name, def] of Object.entries(resolvedAgents)) {
          existing[name] = existing[name] ? { ...def, ...existing[name] } : { ...def }
        }
      }

      const cfgMcp = cfg.mcp as Record<string, unknown> | undefined
      if (cfgMcp) Object.assign(cfgMcp, mcps)
      else cfg.mcp = { ...mcps }

      const commands = loadCommands()
      if (Object.keys(commands).length > 0) {
        if (!cfg.command || typeof cfg.command !== "object") cfg.command = {}
        const cfgCmd = cfg.command as Record<string, unknown>
        for (const [name, cmd] of Object.entries(commands)) {
          if (!cfgCmd[name]) cfgCmd[name] = cmd
        }
      }

      const skillsDir = join(__dir, "..", "src", "skills")
      if (existsSync(skillsDir)) {
        const cfgAny = cfg as Record<string, unknown>
        const skills = (cfgAny.skills && typeof cfgAny.skills === "object" ? cfgAny.skills : { paths: [] }) as { paths?: string[] }
        if (!skills.paths) skills.paths = []
        if (!skills.paths.includes(skillsDir)) skills.paths.push(skillsDir)
        cfgAny.skills = skills
      }

      const { paths: rulePaths, diagnostics } = lazyLoadRulePaths(directory)
      appLog(diagnostics)
      if (rulePaths.length > 0) {
        if (!Array.isArray(cfg.instructions)) cfg.instructions = []
        const seen = new Set(cfg.instructions as string[])
        for (const p of rulePaths) if (!seen.has(p)) (cfg.instructions as string[]).push(p)
      }
    },

    tool: {
      "doctor": doctorTool,
      "planning-state": planningStateTool,
      "codebase-state": codebaseStateTool,
      "repo-memory": repoMemoryTool,
      "hash-edit": hashEditTool,
      "codegraph": codegraphTool,
      "load-rules": loadRulesTool,
      "list-rules": listRulesTool,
      "capture-lesson": captureLessonTool,
      "review-lessons": reviewLessonsTool,
      "fdx-context": fdxContextTool,
      "fdx-decisions": fdxDecisionsTool,
      "fdx-validate": fdxValidateTool,
      "fdx-worktree": fdxWorktreeTool,
      "fdx-read": fdxReadTool,
      "fdx-search": fdxSearchTool,
      "fdx-grep": fdxGrepTool,
      "fdx-batch": fdxBatchTool,
      "fdx-impact": fdxImpactTool,
      "fdx-outline": fdxOutlineTool,
      "fdx-diff": fdxDiffTool,
      "fdx-git": fdxGitTool,
      "fdx-ls": fdxLsTool,
      "fdx-tree": fdxTreeTool,
      "fdx-test": fdxTestTool,
      "fdx-lint": fdxLintTool,
      "debug-audit": debugLogsTool,
    },

    "tool.execute.before": async (toolInput: any, toolOutput: any) => {
      const toolName = toolInput.tool ?? toolInput.name ?? "unknown"
      const sessionID = toolInput.sessionID ?? ""
      const agent = toolInput.agent ?? "unknown"

      // ── 0. Tool call budget tracking ─────────────────────────────────
      if (sessionID) {
        const callCount = (sessionToolCalls.get(sessionID) ?? 0) + 1
        sessionToolCalls.set(sessionID, callCount)
        if (callCount > maxToolCalls) {
          const msg = `Tool call budget exceeded: ${callCount} > ${maxToolCalls} for session ${sessionID}`
          const govMode = resolveGovernanceMode(directory)
          recordRecoveryAudit({
            directory, sessionID, agent,
            errorKey: "tool_call_budget_exceeded",
            action: govMode === "strict" ? "circuit_breaker_block" : "targeted_diagnosis",
            message: msg,
          })
          if (govMode === "strict") {
            throw new Error(msg)
          }
          // advisory: warn and continue
          appLog(`[ADVISORY] ${msg}`, "warn", sessionID)
        }
      }

      // ── 1. Orchestrator guard ──────────────────────────────────────────
      orchestratorGuard.check(
        sessionID,
        toolName,
        toolOutput?.args ?? toolInput?.args,
        agent,
      )

      // ── 2. Governance tool check (off/advisory/strict) ────────────────
      const governanceResult = evaluateGovernanceToolCheck({
        directory,
        sessionID,
        agent,
        tool: toolName,
        args: toolInput.args,
      })

      if (governanceResult.action === "block") {
        if (sessionID) sessionBlocks.set(sessionID, (sessionBlocks.get(sessionID) ?? 0) + 1)
        throw new Error(governanceResult.reason ?? `Tool ${toolName} blocked by governance policy`)
      }
      if (governanceResult.action === "warn") {
        if (sessionID) sessionWarnings.set(sessionID, (sessionWarnings.get(sessionID) ?? 0) + 1)
      }

      // ── 3. Delegation depth check & budget ───────────────────────────
      if (toolName === "task") {
        // Read depth from session state or tool args
        const currentDepth = (toolInput.args?.depth as number) ?? 0
        const targetAgent = (toolInput.args?.agent as string) ?? "unknown"
        const depthResult = validateDelegationDepth(agent, targetAgent, currentDepth, specialistAgentSet, maxDepth)
        if (!depthResult.allowed) {
          recordRecoveryAudit({
            directory,
            sessionID,
            agent,
            errorKey: "delegation_depth_exceeded",
            action: "circuit_breaker_block",
            message: depthResult.reason ?? "Delegation not allowed",
          })
          if (sessionID) sessionBlocks.set(sessionID, (sessionBlocks.get(sessionID) ?? 0) + 1)
          throw new Error(depthResult.reason ?? "Delegation blocked")
        }

        // Track delegation count per session
        if (sessionID) {
          const delCount = (sessionDelegations.get(sessionID) ?? 0) + 1
          sessionDelegations.set(sessionID, delCount)
          if (delCount > maxDelegations) {
            const msg = `Delegation budget exceeded: ${delCount} > ${maxDelegations} for session ${sessionID}`
            const govMode = resolveGovernanceMode(directory)
            recordRecoveryAudit({
              directory, sessionID, agent,
              errorKey: "delegation_budget_exceeded",
              action: govMode === "strict" ? "circuit_breaker_block" : "targeted_diagnosis",
              message: msg,
            })
            if (govMode === "strict") {
              throw new Error(msg)
            }
            // advisory: warn and continue
            appLog(`[ADVISORY] ${msg}`, "warn", sessionID)
          }
        }
      }

      // ── 4. Supervisor preflight review ────────────────────────────────
      const supConfig = resolveSupervisorConfig(directory)
      if (supConfig.enabled) {
        const decision = runSupervisorReview(directory, toolName, {
          currentPhase: toolInput.args?.phase as string | undefined,
          isTrivial: toolInput.args?.trivial === true,
        })
        if (!shouldProceed(decision, supConfig.mode, supConfig.canBlock)) {
          appendAuditEvent(directory, {
            kind: "supervisor.block",
            session_id: sessionID,
            agent,
            tool: toolName,
            decision: "block",
            reason: decision.reasons.join("; "),
          })
          throw new Error(`Supervisor blocked: ${decision.reasons.join("; ")}`)
        }
        appendAuditEvent(directory, {
          kind: "supervisor.approve",
          session_id: sessionID,
          agent,
          tool: toolName,
          decision: "approve",
          reason: "Supervisor approved execution",
        })
      }

      // ── 5. Guard rails ──────────────────────────────────────────────
      await guardRailsHook({ directory }, toolInput, toolOutput)

      // ── 6. Tool guard ───────────────────────────────────────────────
      await toolGuardHook({ directory }, toolInput, toolOutput)

      // ── 7. Loop detection ────────────────────────────────────────────
      const loop = loopDetector.checkBefore(
        toolName,
        toolOutput?.args ?? toolInput?.args ?? {},
        sessionID,
      )
      if (loop.action === "block") throw new Error(loop.escalationMessage)
      if (loop.action === "warn") appLog(loop.message, "warn", sessionID)
    },

    "tool.execute.after": async (toolInput: any) => {
      const toolName = toolInput.tool ?? toolInput.name ?? "unknown"
      const sessionID = toolInput.sessionID ?? ""
      const agent = toolInput.agent ?? "unknown"
      appLog(`[tool] done tool=${toolName} session=${sessionID}`)

      // ── 0. Track files changed for scorecard ─────────────────────────
      if (sessionID && toolName && toolInput.args?.file && !toolInput.error) {
        if (!sessionFilesChanged.has(sessionID)) {
          sessionFilesChanged.set(sessionID, new Set())
        }
        sessionFilesChanged.get(sessionID)!.add(String(toolInput.args.file))
      }

      // ── 1. Post-write verification lifecycle ──────────────────────────
      executePostWriteHook(directory, sessionID, agent, toolName, toolInput.args ?? {})

      // ── 2. Governance verified post-write ─────────────────────────────
      executeVerifiedPostWrite(directory, {
        sessionID,
        agent,
        tool: toolName,
        filePath: toolInput.args?.file as string | undefined,
      })

      // ── 3. Record in loop detector ────────────────────────────────────
      loopDetector.recordAfter(
        toolName,
        toolInput.args ?? {},
        toolInput.output ?? "[unavailable]",
        sessionID,
        "success"
      )

      // ── 4. Recovery tracking & retry budget ──────────────────────────
      if (toolInput.error) {
        recordRecoveryAudit({
          directory,
          sessionID,
          agent,
          errorKey: `${toolName}:${String(toolInput.error).slice(0, 100)}`,
          action: "targeted_diagnosis",
          message: `Tool ${toolName} failed: ${String(toolInput.error).slice(0, 200)}`,
        })

        // Track retries per session and enforce retry budget
        if (sessionID) {
          const retryCount = (sessionRetries.get(sessionID) ?? 0) + 1
          sessionRetries.set(sessionID, retryCount)
          if (retryCount > maxRetries) {
            const msg = `Retry budget exceeded: ${retryCount} > ${maxRetries} for session ${sessionID}`
            const govMode = resolveGovernanceMode(directory)
            recordRecoveryAudit({
              directory, sessionID, agent,
              errorKey: "retry_budget_exceeded",
              action: govMode === "strict" ? "circuit_breaker_block" : "targeted_diagnosis",
              message: msg,
            })
            if (govMode === "strict") {
              throw new Error(msg)
            }
            // advisory: warn and continue
            appLog(`[ADVISORY] ${msg}`, "warn", sessionID)
          }
        }
      }
    },

    event: async ({ event }: { event: any }) => {
      const type: string = event?.type ?? ""
      const sessionID = event?.properties?.sessionID ?? event?.properties?.info?.id ?? event?.sessionID ?? ""
      if (type === "session.created" || type === "session.started") {
        await sessionStartHook({ directory }, appLog)
        appendAuditEvent(directory, {
          kind: "session.started",
          session_id: sessionID,
          agent: "system",
          decision: "start",
          reason: "Session started",
        })
        if (sessionID) {
          cleanupSessionState(sessionID, loopDetector)
          sessionStartTimes.set(sessionID, Date.now())
        }
      } else if (type === "session.completed" || type === "session.error") {
        try {
          await sessionEventsHook({ directory }, type === "session.completed" ? "completed" : "error", sessionID)
          if (type === "session.completed") {
            appendAuditEvent(directory, {
              kind: "session.completed",
              session_id: sessionID,
              agent: "system",
              decision: "complete",
              reason: "Session completed",
            })

            // Generate scorecard with real session metrics
            if (sessionID) {
              const toolCalls = sessionToolCalls.get(sessionID) ?? 0
              const retries = sessionRetries.get(sessionID) ?? 0
              const delegations = sessionDelegations.get(sessionID) ?? 0
              const blocks = sessionBlocks.get(sessionID) ?? 0
              const warnings = sessionWarnings.get(sessionID) ?? 0
              const startTime = sessionStartTimes.get(sessionID)
              const durationMs = startTime ? Date.now() - startTime : null
              const filesChangedSet = sessionFilesChanged.get(sessionID)
              const filesChanged = filesChangedSet ? filesChangedSet.size : null

              const scorecard = generateScorecard({
                commandsRun: toolCalls,
                testsPassed: null,
                testsFailed: null,
                buildResult: null,
                typecheckResult: null,
                filesChanged,
                toolCalls,
                delegations,
                retries,
                blocks,
                warnings,
                durationMs,
                remainingFindings: null,
              })
              await appLog(`[scorecard] Session ${sessionID}: ${JSON.stringify(scorecard)}`)
            }
          } else if (type === "session.error") {
            appendAuditEvent(directory, {
              kind: "session.completed",
              session_id: sessionID,
              agent: "system",
              decision: "error",
              reason: "Session errored",
            })
          }
        } finally {
          // Outer finally: guaranteed cleanup even if hook, audit log, scorecard, or appLog throws!
          if (sessionID) {
            cleanupSessionState(sessionID, loopDetector)
          }
        }
      } else if (type === "session.idle") {
        // session.idle is nonterminal: preserve accumulated metrics!
        await sessionEventsHook({ directory }, "idle", sessionID)
      }
      orchestratorGuard.onEvent(event)
    },
  }
}

/**
 * Single authoritative cleanup function for session state.
 * Clears all session metrics, loop detector state, and write counters.
 */
export function cleanupSessionState(sessionID: string, ld?: LoopDetector): void {
  if (!sessionID) return
  sessionToolCalls.delete(sessionID)
  sessionRetries.delete(sessionID)
  sessionDelegations.delete(sessionID)
  sessionBlocks.delete(sessionID)
  sessionWarnings.delete(sessionID)
  sessionStartTimes.delete(sessionID)
  sessionFilesChanged.delete(sessionID)
  if (ld) {
    try { ld.clearSession(sessionID) } catch {}
  }
  try { clearWriteCounter(sessionID) } catch {}
}

export function getSessionMetricsDiagnostics(sessionID: string): {
  toolCalls: number
  retries: number
  delegations: number
  blocks: number
  warnings: number
  startTime?: number
  filesChangedCount: number
} {
  return {
    toolCalls: sessionToolCalls.get(sessionID) ?? 0,
    retries: sessionRetries.get(sessionID) ?? 0,
    delegations: sessionDelegations.get(sessionID) ?? 0,
    blocks: sessionBlocks.get(sessionID) ?? 0,
    warnings: sessionWarnings.get(sessionID) ?? 0,
    startTime: sessionStartTimes.get(sessionID),
    filesChangedCount: sessionFilesChanged.get(sessionID)?.size ?? 0,
  }
}

const flowDeckPlugin = {
  id: "@heidi-dang/flowdeck",
  server: plugin,
}

export default flowDeckPlugin

// ─── Production diagnostics exports ──────────────────────────────────────────
// These named exports are consumed by scripts/doctor-engine.mjs when running
// as a packed npm package (no src/ directory available). Doctor imports them
// via `import("../dist/index.js")` and verifies each probe executes correctly.
// Removing or renaming any export here will cause the corresponding Doctor
// check to FAIL (not silently pass).
export { AGENT_NAMES, createAgent } from "./agents/index"
export { validateDelegationDepth, evaluateGovernanceToolCheck } from "./services/governance-wiring"
export { acquireLock, releaseLock } from "./services/async-lock"
