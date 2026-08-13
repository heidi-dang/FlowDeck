import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { join } from "node:path"
import { initializeDatabase } from "../orchestration/persistence"
import { HeidiPersistentAgentStore, type MemoryScope } from "../services/heidi-persistent-agent"
import { isSpecialistAgent } from "../services/canonical-registry"

function store(directory: string): HeidiPersistentAgentStore {
  return new HeidiPersistentAgentStore(initializeDatabase({ path: join(directory, ".flowdeck", "flowdeck.db") }).db)
}

export const heidiMemoryTool: ToolDefinition = tool({
  description: "Manage governed persistent Heidi user, agent, or repository memory. Unsafe or secret content is rejected.",
  args: {
    action: tool.schema.enum(["add", "list", "deactivate", "history", "rollback"]),
    scope: tool.schema.enum(["user", "agent", "repo"]).optional(),
    kind: tool.schema.string().optional(), content: tool.schema.string().optional(), canonical_key: tool.schema.string().optional(), id: tool.schema.string().optional(), version: tool.schema.number().optional(), confidence: tool.schema.number().optional(), source_type: tool.schema.string().optional(), evidence_refs: tool.schema.array(tool.schema.string()).optional(), limit: tool.schema.number().optional(),
  },
  async execute(args, context): Promise<string> {
    const directory = context.directory ?? process.cwd(); const agent = (context as { agent?: string }).agent
    if (args.action === "add" && isSpecialistAgent(agent ?? "")) return JSON.stringify({ error: "Specialists may submit candidates but cannot mutate durable Heidi memory." })
    const db = store(directory)
    if (args.action === "add") { if (!args.scope || !args.kind || !args.content) return JSON.stringify({ error: "scope, kind, and content are required" }); return JSON.stringify(db.addMemory({ scope: args.scope as MemoryScope, kind: args.kind, content: args.content, canonicalKey: args.canonical_key, confidence: args.confidence, sourceType: args.source_type, sourceAgent: agent, evidenceRefs: args.evidence_refs })) }
    if (args.action === "list") return JSON.stringify(db.listMemory(args.scope as MemoryScope | undefined, args.limit ?? 20))
    if (!args.id) return JSON.stringify({ error: "id is required" })
    if (args.action === "deactivate") { db.deactivateMemory(args.id); return JSON.stringify({ success: true, id: args.id }) }
    if (args.action === "history") return JSON.stringify(db.history(args.id))
    if (args.action === "rollback") { if (args.version === undefined) return JSON.stringify({ error: "version is required" }); return JSON.stringify(db.rollbackMemory(args.id, args.version)) }
    return JSON.stringify({ error: "unsupported action" })
  },
})

export const heidiRecallTool: ToolDefinition = tool({
  description: "Search archived Heidi/OpenCode session messages using SQLite FTS5.",
  args: { query: tool.schema.string(), repository: tool.schema.string().optional(), session_id: tool.schema.string().optional(), limit: tool.schema.number().optional(), offset: tool.schema.number().optional() },
  async execute(args, context): Promise<string> { return JSON.stringify(store(context.directory ?? process.cwd()).searchSessions(args.query, { repository: args.repository, sessionId: args.session_id, limit: args.limit, offset: args.offset })) },
})
