import type { Database } from "bun:sqlite"
import type { TransactionManager } from "../persistence/transaction-manager"
import { canonicalize, routingDecisionSchema, type RoutingDecision } from "./contracts/task-intelligence"
import type { RoutingDecisionStore } from "./store"

const EVENT_TYPE = "routing.decision.finalized"
const AGGREGATE_TYPE = "routing_decision"

/** Authoritative routing persistence. The existing append-only events table is SQLite-backed,
 * transactional, and uniquely versions aggregates; JSONL is deliberately not used here. */
export class SqliteRoutingDecisionRepository implements RoutingDecisionStore {
  constructor(private readonly db: Database, private readonly tx: TransactionManager) {}

  saveDecision(decision: RoutingDecision): RoutingDecision {
    const parsed = routingDecisionSchema.parse(decision)
    return this.tx.write(() => {
      const duplicate = this.db.query("SELECT event_id FROM events WHERE event_id = ?").get(parsed.routingDecisionId)
      if (duplicate) {
        const existingRow = this.db.query("SELECT data FROM events WHERE event_id = ? AND event_type = ?").get(parsed.routingDecisionId, EVENT_TYPE) as { data: string } | null
        if (existingRow && canonicalize(JSON.parse(existingRow.data)) === canonicalize(parsed)) return routingDecisionSchema.parse(JSON.parse(existingRow.data))
        throw new Error("ROUTING_DECISION_IMMUTABLE")
      }
      const row = this.db.query(
        "SELECT COALESCE(MAX(aggregate_version), 0) AS version FROM events WHERE event_type = ? AND aggregate_type = ? AND aggregate_id = ?",
      ).get(EVENT_TYPE, AGGREGATE_TYPE, parsed.runId) as { version: number }
      const persisted = routingDecisionSchema.parse({ ...parsed, decisionVersion: row.version + 1 })
      const now = Date.now()
      this.db.query(`INSERT INTO events
        (event_id, event_type, event_version, aggregate_type, aggregate_id, aggregate_version, timestamp, data, metadata, created_ts)
        VALUES (?, ?, 1, ?, ?, ?, ?, ?, '{}', ?)`)
        .run(persisted.routingDecisionId, EVENT_TYPE, AGGREGATE_TYPE, persisted.runId,
          persisted.decisionVersion, persisted.createdAt, JSON.stringify(persisted), now)
      return persisted
    })
  }

  get(routingDecisionId: string): RoutingDecision | null {
    const row = this.db.query("SELECT data FROM events WHERE event_id = ? AND event_type = ?").get(routingDecisionId, EVENT_TYPE) as { data: string } | null
    return row ? routingDecisionSchema.parse(JSON.parse(row.data)) : null
  }

  getLatestDecisionForRun(runId: string): RoutingDecision | null {
    const row = this.db.query("SELECT data FROM events WHERE event_type = ? AND aggregate_type = ? AND aggregate_id = ? ORDER BY aggregate_version DESC LIMIT 1").get(EVENT_TYPE, AGGREGATE_TYPE, runId) as { data: string } | null
    return row ? routingDecisionSchema.parse(JSON.parse(row.data)) : null
  }

  listDecisionsForRun(runId: string): RoutingDecision[] {
    const rows = this.db.query("SELECT data FROM events WHERE event_type = ? AND aggregate_type = ? AND aggregate_id = ? ORDER BY aggregate_version ASC").all(EVENT_TYPE, AGGREGATE_TYPE, runId) as Array<{ data: string }>
    return rows.map(row => routingDecisionSchema.parse(JSON.parse(row.data)))
  }
}
