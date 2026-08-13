import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { join } from "node:path"
import { initializeDatabase } from "../orchestration/persistence"
import { HeidiDelegationRuntime } from "../services/heidi-delegation-runtime"

export const heidiAgentsTool: ToolDefinition = tool({ description: "Inspect and ownership-scope control of durable delegated child activity.", args: { action: tool.schema.enum(["list","inspect","cancel","steer"]), child_id: tool.schema.string().optional(), instruction: tool.schema.string().optional() }, async execute(args, context): Promise<string> { const owner = (context as { sessionID?: string }).sessionID; const runtime = new HeidiDelegationRuntime(initializeDatabase({ path: join(context.directory ?? process.cwd(), ".flowdeck", "flowdeck.db") }).db); if (args.action === "list") return JSON.stringify(runtime.list(owner)); if (!args.child_id) return JSON.stringify({ error: "child_id required" }); if (args.action === "inspect") return JSON.stringify(runtime.inspect(args.child_id, owner)); return JSON.stringify(runtime.control(args.child_id, args.action, args.instruction, owner ?? "")) } })
