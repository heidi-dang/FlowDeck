import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { join } from "node:path"
import { initializeDatabase } from "../orchestration/persistence"
import { HeidiPersistentAgentStore } from "../services/heidi-persistent-agent"

export const heidiArchiveSessionTool: ToolDefinition = tool({
  description: "Archive a bounded conversation projection for future cross-session recall.",
  args: { session_id: tool.schema.string(), messages: tool.schema.array(tool.schema.object({ role: tool.schema.string(), content: tool.schema.string(), tool_summary: tool.schema.string().optional() })) },
  async execute(args, context): Promise<string> { const db = new HeidiPersistentAgentStore(initializeDatabase({ path: join(context.directory ?? process.cwd(), ".flowdeck", "flowdeck.db") }).db); db.archiveSession(args.session_id, args.messages.map(m => ({ role: m.role, content: m.content, toolSummary: m.tool_summary })), { repository: context.directory }); return JSON.stringify({ success: true, session_id: args.session_id, messages: args.messages.length }) },
})
