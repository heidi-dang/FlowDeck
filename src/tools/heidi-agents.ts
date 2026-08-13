import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import { join } from "node:path"
import { initializeDatabase } from "../orchestration/persistence"
import { HeidiDelegationRuntime } from "../services/heidi-delegation-runtime"
import { HeidiParallelEngine } from "../services/heidi-parallel-engine"

export const heidiAgentsTool: ToolDefinition = tool({
  description: "Inspect and ownership-scope control of durable delegated child activity and parallel execution DAG runs.",
  args: {
    action: tool.schema.enum(["list", "inspect", "cancel", "steer", "dag_run", "dag_inspect"]),
    child_id: tool.schema.string().optional(),
    run_id: tool.schema.string().optional(),
    instruction: tool.schema.string().optional(),
  },
  async execute(args, context): Promise<string> {
    const owner = (context as { sessionID?: string }).sessionID
    const db = initializeDatabase({ path: join(context.directory ?? process.cwd(), ".flowdeck", "flowdeck.db") }).db
    const runtime = new HeidiDelegationRuntime(db)
    const engine = new HeidiParallelEngine(db)

    if (args.action === "list") return JSON.stringify(runtime.list(owner))
    if (args.action === "dag_run" && args.run_id) return JSON.stringify(engine.getRun(args.run_id))
    if (args.action === "dag_inspect" && args.run_id) return JSON.stringify(engine.getRun(args.run_id))
    if (!args.child_id) return JSON.stringify({ error: "child_id required" })
    if (args.action === "inspect") return JSON.stringify(runtime.inspect(args.child_id, owner))
    return JSON.stringify(runtime.control(args.child_id, args.action as "cancel" | "steer", args.instruction, owner ?? ""))
  },
})
