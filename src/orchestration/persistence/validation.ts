/** Startup schema validation with detailed diagnostic categories. */
import type Database from "better-sqlite3"
import { getCurrentVersion } from "./migrations/migration-runner"

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

export interface SchemaDiagnostics {
  valid: boolean
  details: Record<string, string[]>
  version: number
  tableCount: number
  triggerCount: number
  indexCount: number
}

export function validateSchema(db: Database.Database): SchemaDiagnostics {
  const errors: string[] = []
  const details: Record<string, string[]> = { errors, warnings: [], missing_tables: [], missing_triggers: [], fk_violations: [], integrity: [] }
  const version = getCurrentVersion(db)

  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name!='sqlite_sequence'").all() as { name: string }[]).map(r => r.name))
  for (const t of REQUIRED_TABLES) { if (!tables.has(t)) details.missing_tables.push(t) }
  if (details.missing_tables.length > 0) errors.push(`${details.missing_tables.length} missing tables`)

  const triggers = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map(r => r.name))
  const REQUIRED_TRIGGERS = ["tr_task_contracts_immutable_update","tr_task_contracts_immutable_delete","tr_requirements_immutable_insert","tr_requirements_immutable_update","tr_requirements_immutable_delete","tr_acceptance_criteria_immutable_insert","tr_acceptance_criteria_immutable_update","tr_acceptance_criteria_immutable_delete","tr_verification_rules_immutable_insert","tr_verification_rules_immutable_update","tr_verification_rules_immutable_delete","tr_objectives_immutable_insert","tr_objectives_immutable_update","tr_objectives_immutable_delete","tr_constraints_immutable_insert","tr_constraints_immutable_update","tr_constraints_immutable_delete","tr_evidence_immutable_update","tr_evidence_immutable_delete","tr_completion_override_allowed_insert","tr_completion_override_allowed_update","tr_run_requirements_contract_consistency","tr_run_acceptance_criteria_contract_consistency","tr_assignment_requirements_contract_consistency","tr_run_criterion_evidence_same_run","tr_contract_lifecycle_family_sync","tr_verification_results_run_consistency","tr_session_metrics_run_consistency","tr_tool_invocations_run_consistency","tr_model_selections_run_consistency","tr_checkpoints_run_consistency","tr_execution_metadata_run_consistency","tr_command_history_run_consistency","tr_context_items_run_consistency","tr_context_snapshots_run_consistency","tr_session_summaries_run_consistency"]
  for (const t of REQUIRED_TRIGGERS) { if (!triggers.has(t)) details.missing_triggers.push(t) }
  if (details.missing_triggers.length > 0) errors.push(`${details.missing_triggers.length} missing triggers`)

  try { const fk = db.prepare("PRAGMA foreign_key_check").all(); if (fk.length > 0) { for (const r of fk as Record<string, unknown>[]) details.fk_violations.push(`table=${r.table}`); errors.push(`${fk.length} FK violations`) } }
  catch (e) { details.integrity.push(`FK error: ${e}`) }

  try { const i = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }; if (i.integrity_check !== "ok") { details.integrity.push(i.integrity_check); errors.push("Integrity check failed") } }
  catch (e) { details.integrity.push(`Integrity error: ${e}`) }

  return {
    valid: errors.length === 0, details, version,
    tableCount: tables.size,
    triggerCount: triggers.size,
    indexCount: (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).length,
  }
}
