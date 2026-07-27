/**
 * Debug Audit Tool
 *
 * Reads recent governance audit events from .codebase/AUDIT.jsonl with
 * optional filters for kind, session_id, level, and agent.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "fs"
import { auditLogPath } from "../services/audit-log"

export const debugLogsTool: ToolDefinition = tool({
  description:
    "Read recent governance audit events with optional filters. Returns structured log lines showing timestamp, level, kind, session, agent, tool, and decision.",
  args: {
    kind: tool.schema.string().optional().describe("Filter by event kind (e.g. guard.block)"),
    session_id: tool.schema.string().optional().describe("Filter by session ID"),
    level: tool.schema.string().optional().describe("Filter by level (debug/info/warn/error)"),
    agent: tool.schema.string().optional().describe("Filter by agent name"),
    limit: tool.schema.number().optional().describe("Max events to return (default 50)"),
  },
  async execute(args, context) {
    const dir = context.directory ?? process.cwd()
    const logPath = auditLogPath(dir)

    if (!existsSync(logPath)) {
      return "No audit log found. No governance events have been recorded yet."
    }

    const raw = readFileSync(logPath, "utf-8")
    let events = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean) as Array<Record<string, unknown>>

    // Apply filters
    if (args.kind) events = events.filter((e) => e.kind === args.kind)
    if (args.session_id) events = events.filter((e) => e.session_id === args.session_id)
    if (args.level) events = events.filter((e) => e.level === args.level)
    if (args.agent) events = events.filter((e) => e.agent === args.agent)

    const limit = args.limit ?? 50
    events = events.slice(-limit)

    if (events.length === 0) {
      return "No matching audit events found."
    }

    const lines = events.map((e) => {
      const ts = e.timestamp ?? "?"
      const lvl = e.level ?? "info"
      const kind = e.kind ?? "?"
      const sess = e.session_id ? ` session=${e.session_id}` : ""
      const agent = e.agent ? ` agent=${e.agent}` : ""
      const toolName = e.tool ? ` tool=${e.tool}` : ""
      const decision = e.decision ? ` → ${e.decision}` : ""
      const reason = e.reason ? `: ${e.reason}` : ""
      return `[${ts}] ${lvl} ${kind}${sess}${agent}${toolName}${decision}${reason}`
    })

    return `Audit events (${events.length}):\n${lines.join("\n")}`
  },
})
