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
} from "./tools/fdx"
import { hashEditTool } from "./tools/hash-edit"
import { loadRulesTool, listRulesTool } from "./tools/load-rules"
import { planningStateTool } from "./tools/planning-state"
import { repoMemoryTool } from "./tools/repo-memory"

// ─── Governance integration ────────────────────────────────────────────────
import {
  evaluateGovernanceToolCheck,
  recordRoutingAudit,
  recordRecoveryAudit,
  executeVerifiedPostWrite,
  generateScorecard,
  validateDelegationDepth,
} from "./services/governance-wiring"
import { runSupervisorReview, shouldProceed, resolveSupervisorConfig } from "./services/supervisor-binding"
import { appendAuditEvent } from "./services/audit-log"
import { isSpecialistAgent, getAllAgentIds } from "./services/canonical-registry"

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
  const appLog = (msg: string): Promise<void> =>
    client.app.log({ body: { service: "flowdeck", level: "info", message: msg } })
      .then(() => undefined).catch(() => {})

  let flowdeckConfig: FlowDeckConfig = loadFlowDeckConfig(directory)
  const orchestratorGuard = new OrchestratorGuard({ routes: getAgentRoutes() })
  const loopDetector = new LoopDetector(flowdeckConfig.governance?.loopDetection, appLog)

  const { mcps } = buildFlowDeckMcpsWithMeta()

  return {
    name: "@heidi-dang/flowdeck",
    agent: {},
    mcp: mcps,

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
    },

    "tool.execute.before": async (toolInput: any, toolOutput: any) => {
      const toolName = toolInput.tool ?? toolInput.name ?? "unknown"
      const sessionID = toolInput.sessionID ?? ""
      const agent = toolInput.agent ?? "unknown"

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
        throw new Error(governanceResult.reason ?? `Tool ${toolName} blocked by governance policy`)
      }

      // ── 3. Delegation depth check ─────────────────────────────────────
      if (toolName === "task") {
        // Read depth from session state or tool args
        const currentDepth = (toolInput.args?.depth as number) ?? 0
        const targetAgent = (toolInput.args?.agent as string) ?? "unknown"
        const depthResult = validateDelegationDepth(agent, targetAgent, currentDepth, specialistAgentSet)
        if (!depthResult.allowed) {
          recordRecoveryAudit({
            directory,
            sessionID,
            agent,
            errorKey: "delegation_depth_exceeded",
            action: "circuit_breaker_block",
            message: depthResult.reason ?? "Delegation not allowed",
          })
          throw new Error(depthResult.reason ?? "Delegation blocked")
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
      if (loop.action === "warn") appLog(loop.message)
    },

    "tool.execute.after": async (toolInput: any) => {
      const toolName = toolInput.tool ?? toolInput.name ?? "unknown"
      const sessionID = toolInput.sessionID ?? ""
      const agent = toolInput.agent ?? "unknown"
      appLog(`[tool] done tool=${toolName} session=${sessionID}`)

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

      // ── 4. Recovery tracking ──────────────────────────────────────────
      if (toolInput.error) {
        recordRecoveryAudit({
          directory,
          sessionID,
          agent,
          errorKey: `${toolName}:${String(toolInput.error).slice(0, 100)}`,
          action: "targeted_diagnosis",
          message: `Tool ${toolName} failed: ${String(toolInput.error).slice(0, 200)}`,
        })
      }
    },

    event: async ({ event }: { event: any }) => {
      const type: string = event?.type ?? ""
      const sessionID = event?.properties?.sessionID ?? ""
      if (type === "session.created" || type === "session.started") {
        await sessionStartHook({ directory }, appLog)
        appendAuditEvent(directory, {
          kind: "session.started",
          session_id: sessionID,
          agent: "system",
          decision: "start",
          reason: "Session started",
        })
      } else if (type === "session.idle" || type === "session.error" || type === "session.completed") {
        await sessionEventsHook({ directory }, type === "session.idle" ? "idle" : "error", sessionID)
        if (sessionID) {
          loopDetector.clearSession(sessionID)
          clearWriteCounter(sessionID)
        }
        if (type === "session.completed") {
          appendAuditEvent(directory, {
            kind: "session.completed",
            session_id: sessionID,
            agent: "system",
            decision: "complete",
            reason: "Session completed",
          })
        }
      }
      orchestratorGuard.onEvent(event)
    },
  }
}

export default plugin
