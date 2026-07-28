/**
 * FDX PR Monitor Tool
 *
 * Controls the event-driven CI auto-repair system.
 * Actions: start | stop | status | run_once | repair_now
 *
 * The actual monitoring runs as a persistent FlowDeck service
 * (PrMonitorService). This tool is the control interface.
 */

import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { PrMonitorService } from "../services/pr-monitor/pr-monitor-service"

// Singleton service instance
let service: PrMonitorService | null = null

function getService(): PrMonitorService {
  if (!service) {
    service = new PrMonitorService()
  }
  return service
}

export const fdxPrMonitorTool: ToolDefinition = tool({
  description:
    "Control the FDX PR Monitor — an event-driven CI auto-repair system. " +
    "Actions: start (begin monitoring a PR), stop (shut down), status (current state), " +
    "run_once (poll once for failures), repair_now (immediately repair all failures). " +
    "When auto_fix mode is active, the monitor detects CI failures, collects logs, " +
    "classifies them, attempts repair, validates locally, and pushes fixes.",
  args: {
    action: tool.schema.enum(["start", "stop", "status", "run_once", "repair_now"]),
    repo: tool.schema.string().optional().describe("Repository (owner/name, e.g. heidi-dang/FlowDeck)"),
    pr: tool.schema.number().optional().describe("PR number"),
    mode: tool.schema.enum(["observe", "auto_fix"]).optional().describe("Monitor mode (default: auto_fix)"),
    max_attempts: tool.schema.number().optional().describe("Max repair attempts per head SHA (default: 3)"),
    retry_flaky_once: tool.schema.boolean().optional().describe("Retry flaky/infrastructure failures once before repairing"),
    job_id: tool.schema.number().optional().describe("Specific job ID to repair (for repair_now)"),
  },
  async execute(args, _context): Promise<string> {
    const s = getService()

    switch (args.action) {
      case "start": {
        if (!args.repo || args.pr === undefined) {
          return JSON.stringify({ ok: false, message: "repo and pr are required for start" })
        }
        const result = await s.start(args.repo, args.pr, args.mode)
        return JSON.stringify(result)
      }

      case "stop": {
        const result = await s.stop()
        return JSON.stringify(result)
      }

      case "status": {
        const status = await s.status()
        return JSON.stringify(status)
      }

      case "run_once": {
        if (!args.repo || args.pr === undefined) {
          return JSON.stringify({ ok: false, message: "repo and pr are required for run_once" })
        }
        const result = await s.runOnce(args.repo, args.pr)
        return JSON.stringify(result)
      }

      case "repair_now": {
        if (!args.repo || args.pr === undefined) {
          return JSON.stringify({ ok: false, message: "repo and pr are required for repair_now" })
        }
        const result = await s.repairNow(args.repo, args.pr, args.job_id)
        return JSON.stringify(result)
      }

      default: {
        return JSON.stringify({ ok: false, message: `Unknown action: ${args.action}` })
      }
    }
  },
})
