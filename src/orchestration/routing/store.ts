import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { routingDecisionSchema, type RoutingDecision } from "./contracts/task-intelligence"

export interface RoutingDecisionStore { saveDecision(decision: RoutingDecision): RoutingDecision; get(routingDecisionId: string): RoutingDecision | null; getLatestDecisionForRun(runId: string): RoutingDecision | null; listDecisionsForRun(runId: string): RoutingDecision[] }

/** Durable append-only shadow record store. Finalized records are never mutated. */
export class JsonlRoutingDecisionStore implements RoutingDecisionStore {
  constructor(private readonly filePath: string) {}
  saveDecision(decision: RoutingDecision): RoutingDecision {
    const parsed = routingDecisionSchema.parse(decision)
    if (this.get(parsed.routingDecisionId)) throw new Error("ROUTING_DECISION_IMMUTABLE")
    const existing = this.listDecisionsForRun(parsed.runId)
    if (existing.some(d => d.sourceSha === parsed.sourceSha && d.assessment.assessmentId === parsed.assessment.assessmentId)) throw new Error("ROUTING_DECISION_DUPLICATE")
    mkdirSync(dirname(this.filePath), { recursive: true })
    appendFileSync(this.filePath, JSON.stringify(parsed) + "\n", { encoding: "utf8" })
    return parsed
  }
  /** Compatibility aliases for diagnostic-only JSONL consumers. */
  append(decision: RoutingDecision): void { this.saveDecision(decision) }
  get(id: string): RoutingDecision | null { return this.read().find(d => d.routingDecisionId === id) ?? null }
  getLatestDecisionForRun(runId: string): RoutingDecision | null { return this.listDecisionsForRun(runId).at(-1) ?? null }
  listDecisionsForRun(runId: string): RoutingDecision[] { return this.read().filter(d => d.runId === runId) }
  list(runId: string): RoutingDecision[] { return this.listDecisionsForRun(runId) }
  private read(): RoutingDecision[] {
    if (!existsSync(this.filePath)) return []
    return readFileSync(this.filePath, "utf8").split("\n").filter(Boolean).map(line => routingDecisionSchema.parse(JSON.parse(line)))
  }
}

export function createRoutingDecisionStore(directory: string): JsonlRoutingDecisionStore {
  return new JsonlRoutingDecisionStore(join(directory, ".flowdeck", "routing-decisions.jsonl"))
}
