/** Startup schema validation. Returns structured diagnostics with recovery recommendations. */

import type Database from "better-sqlite3"
import { getCurrentVersion } from "./migrations/migration-runner"

export interface DiagnosticItem {
  object: string
  detail: string
  severity: "error" | "warning"
  recovery?: string
}

export interface SchemaDiagnostics {
  valid: boolean
  version: number
  tableCount: number
  triggerCount: number
  indexCount: number
  items: DiagnosticItem[]
  machine: {
    missingTables: string[]
    missingTriggers: string[]
    fkViolations: string[]
    integrityErrors: string[]
  }
}

const REQUIRED_TABLES = [
  "contract_families","task_contracts","contract_lifecycle","requirements","acceptance_criteria",
  "verification_rules","objectives","constraints","task_runs","run_requirements",
  "run_acceptance_criteria","assignments","assignment_requirements","assignment_dependencies",
  "assignment_files","assignment_results","verification_results","agent_sessions","session_metrics",
  "override_policy","completion_overrides","completion_decisions","evidence","evidence_lifecycle",
  "run_criterion_evidence","events","event_subscribers","consumer_offsets","event_outbox",
  "event_deliveries","dead_letter_events","command_idempotency","repositories","worktrees",
  "run_path_ownership","path_ownership_conflicts","path_renames","path_deletions",
  "tool_invocations","model_selections","checkpoints","cancellation_tokens",
  "cancellation_acknowledgements","heartbeats","execution_metadata","command_history",
  "active_locks","recovery_attempts","context_items","context_snapshots","session_summaries",
  "compaction_records","schema_migrations",
]

const REQUIRED_TRIGGERS = [
  "tr_task_contracts_immutable_update","tr_task_contracts_immutable_delete",
  "tr_requirements_immutable_insert","tr_requirements_immutable_update","tr_requirements_immutable_delete",
  "tr_acceptance_criteria_immutable_insert","tr_acceptance_criteria_immutable_update","tr_acceptance_criteria_immutable_delete",
  "tr_verification_rules_immutable_insert","tr_verification_rules_immutable_update","tr_verification_rules_immutable_delete",
  "tr_objectives_immutable_insert","tr_objectives_immutable_update","tr_objectives_immutable_delete",
  "tr_constraints_immutable_insert","tr_constraints_immutable_update","tr_constraints_immutable_delete",
  "tr_evidence_immutable_update","tr_evidence_immutable_delete",
  "tr_completion_override_allowed_insert","tr_completion_override_allowed_update",
  "tr_run_requirements_contract_consistency","tr_run_acceptance_criteria_contract_consistency",
  "tr_assignment_requirements_contract_consistency",
  "tr_run_criterion_evidence_same_run","tr_contract_lifecycle_family_sync",
  "tr_verification_results_run_consistency",
  "tr_session_metrics_run_consistency","tr_tool_invocations_run_consistency",
  "tr_model_selections_run_consistency","tr_checkpoints_run_consistency",
  "tr_execution_metadata_run_consistency","tr_command_history_run_consistency",
  "tr_context_items_run_consistency","tr_context_snapshots_run_consistency",
  "tr_session_summaries_run_consistency",
]

const RECOVERY_MAP: Record<string, string> = {
  missing_tables: "Run migrations to create missing tables. Ensure schema-v0.2.6.sql is the current migration.",
  missing_triggers: "Run migrations to create missing triggers. Triggers enforce immutability and consistency.",
  fk_violations: "Investigate orphaned rows. Run DELETE/UPDATE on violating tables to restore referential integrity.",
  integrity: "Database corruption detected. Restore from backup or run PRAGMA integrity_check for details.",
}

export function validateSchema(db: Database.Database): SchemaDiagnostics {
  const items: DiagnosticItem[] = []
  const machine = { missingTables: [] as string[], missingTriggers: [] as string[], fkViolations: [] as string[], integrityErrors: [] as string[] }
  const version = getCurrentVersion(db)

  const tables = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='sqlite_sequence'").all() as { name: string }[]).map(r => r.name)
  )
  for (const t of REQUIRED_TABLES) {
    if (!tables.has(t)) {
      machine.missingTables.push(t)
      items.push({ object: t, detail: `Missing required table: ${t}`, severity: "error", recovery: RECOVERY_MAP.missing_tables })
    }
  }

  const triggers = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map(r => r.name)
  )
  for (const t of REQUIRED_TRIGGERS) {
    if (!triggers.has(t)) {
      machine.missingTriggers.push(t)
      items.push({ object: t, detail: `Missing required trigger: ${t}`, severity: "error", recovery: RECOVERY_MAP.missing_triggers })
    }
  }

  try {
    const fk = db.prepare("PRAGMA foreign_key_check").all() as { table: string; rowid: number; parent: string }[]
    for (const r of fk) {
      const d = `FK violation: table=${r.table} rowid=${r.rowid} parent=${r.parent}`
      machine.fkViolations.push(d)
      items.push({ object: `${r.table}.${r.rowid}`, detail: d, severity: "error", recovery: RECOVERY_MAP.fk_violations })
    }
  } catch (e) {
    machine.integrityErrors.push(`FK check error: ${e}`)
    items.push({ object: "PRAGMA foreign_key_check", detail: `Failed: ${e}`, severity: "error", recovery: "Check database permissions and integrity." })
  }

  try {
    const i = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }
    if (i.integrity_check !== "ok") {
      machine.integrityErrors.push(i.integrity_check)
      items.push({ object: "database", detail: `Integrity check: ${i.integrity_check}`, severity: "error", recovery: RECOVERY_MAP.integrity })
    }
  } catch (e) {
    machine.integrityErrors.push(`Integrity error: ${e}`)
  }

  return {
    valid: items.filter(i => i.severity === "error").length === 0,
    version,
    tableCount: tables.size,
    triggerCount: triggers.size,
    indexCount: (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).length,
    items,
    machine,
  }
}
