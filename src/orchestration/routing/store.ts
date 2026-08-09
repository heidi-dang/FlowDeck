import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { routingDecisionSchema, type RoutingDecision } from "./contracts/task-intelligence"

export interface RoutingDecisionStore { append(decision: RoutingDecision): void; get(routingDecisionId: string): RoutingDecision | null; list(runId: string): RoutingDecision[] }

/** Durable append-only shadow record store. Finalized records are never mutated. */
export class JsonlRoutingDecisionStore implements RoutingDecisionStore {
  constructor(private readonly filePath: string) {}
  append(decision: RoutingDecision): void {
    const parsed = routingDecisionSchema.parse(decision)
    if (this.get(parsed.routingDecisionId)) throw new Error("ROUTING_DECISION_IMMUTABLE")
    const existing = this.list(parsed.runId)
    if (existing.some(d => d.sourceSha === parsed.sourceSha && d.assessment.assessmentId === parsed.assessment.assessmentId)) throw new Error("ROUTING_DECISION_DUPLICATE")
    mkdirSync(dirname(this.filePath), { recursive: true })
    appendFileSync(this.filePath, JSON.stringify(parsed) + "\n", { encoding: "utf8" })
  }
  get(id: string): RoutingDecision | null { return this.read().find(d => d.routingDecisionId === id) ?? null }
  list(runId: string): RoutingDecision[] { return this.read().filter(d => d.runId === runId) }
  private read(): RoutingDecision[] {
    if (!existsSync(this.filePath)) return []
    return readFileSync(this.filePath, "utf8").split("\n").filter(Boolean).map(line => routingDecisionSchema.parse(JSON.parse(line)))
  }
}

export function createRoutingDecisionStore(directory: string): JsonlRoutingDecisionStore {
  return new JsonlRoutingDecisionStore(join(directory, ".flowdeck", "routing-decisions.jsonl"))
}
