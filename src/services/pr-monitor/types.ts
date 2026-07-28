/**
 * FDX PR Monitor — types and interfaces.
 *
 * Shared types for the event-driven CI auto-repair system.
 * Both the TypeScript service and the Rust CLI use these shapes.
 */

// ─── Monitor Actions ────────────────────────────────────────────────────

export type PrMonitorAction = "start" | "stop" | "status" | "run_once" | "repair_now"
export type PrMonitorMode = "observe" | "auto_fix"
export type EventSource = "github_app" | "polling"

export interface PrMonitorStartArgs {
  repo: string
  pr: number
  mode?: PrMonitorMode
  max_attempts?: number
  retry_flaky_once?: boolean
  event_source?: EventSource
}

export interface PrMonitorStatusArgs {
  repo?: string
  pr?: number
}

export interface PrMonitorRepairNowArgs {
  repo: string
  pr: number
  job_id?: number
}

// ─── Config ──────────────────────────────────────────────────────────────

export interface PrMonitorConfig {
  enabled: boolean
  mode: PrMonitorMode
  event_source: EventSource
  max_concurrent_repairs: number
  max_attempts_per_head_sha: number
  retry_flaky_once: boolean
  push: {
    enabled: boolean
    same_repository_only: boolean
    require_unchanged_head_sha: boolean
    commit_prefix: string
  }
  validation: {
    required_gate: { command: string; args: string[] }
  }
  prohibited_paths: string[]
  auto_merge: boolean
  auto_release: boolean
}

export const DEFAULT_PR_MONITOR_CONFIG: PrMonitorConfig = {
  enabled: true,
  mode: "auto_fix",
  event_source: "github_app",
  max_concurrent_repairs: 1,
  max_attempts_per_head_sha: 3,
  retry_flaky_once: true,
  push: {
    enabled: true,
    same_repository_only: true,
    require_unchanged_head_sha: true,
    commit_prefix: "fix(ci):",
  },
  validation: {
    required_gate: { command: "node", args: ["scripts/pre-push.mjs"] },
  },
  prohibited_paths: [".github/workflows/release.yml", ".env", ".env.*"],
  auto_merge: false,
  auto_release: false,
}

// ─── GitHub Webhook ─────────────────────────────────────────────────────

export interface GitHubWebhookPayload {
  delivery_id: string
  event: string
  signature_256: string
  body: unknown
}

// ─── CI Failure ─────────────────────────────────────────────────────────

export interface CiFailureReport {
  schema_version: 1
  repository: string
  pr_number: number
  head_sha: string
  workflow_run_id: number
  run_attempt: number
  job_id: number
  job_name: string
  runner_os?: string
  failed_step?: string
  conclusion: string
  exit_code?: number
  error_excerpt: string
  changed_files: string[]
  suspected_files: string[]
  classification: FailureClassification
}

export type FailureClassification =
  | "code"
  | "test"
  | "lint"
  | "typecheck"
  | "build"
  | "packaging"
  | "migration"
  | "platform"
  | "flaky"
  | "infrastructure"
  | "unknown"

// ─── State Machine ──────────────────────────────────────────────────────

export type RepairState =
  | "IDLE"
  | "FAILURE_DETECTED"
  | "CLAIMED"
  | "LOGS_COLLECTED"
  | "CLASSIFIED"
  | "REPAIRING"
  | "LOCAL_VALIDATION"
  | "PUSHING"
  | "WAITING_FOR_NEW_CI"
  | "GREEN"

export type RepairExitState =
  | "BLOCKED"
  | "STALE_HEAD"
  | "MAX_ATTEMPTS_REACHED"
  | "INFRASTRUCTURE_FAILURE"
  | "MODEL_FAILED"
  | "LOCAL_VALIDATION_FAILED"

export type RepairTerminal = RepairState | RepairExitState

// ─── Repair Run ─────────────────────────────────────────────────────────

export interface RepairRun {
  repair_key: string
  repo: string
  pr_number: number
  head_sha: string
  workflow_run_id: number
  run_attempt: number
  job_id: number
  job_name: string
  state: RepairTerminal
  attempt_count: number
  max_attempts: number
  failure_report?: CiFailureReport
  created_at: string
  updated_at: string
  committed_sha?: string
  ci_run_id?: number
}

export function buildRepairKey(repo: string, prNumber: number, headSha: string): string {
  return `${repo}:${prNumber}:${headSha}`
}

export function buildDedupKey(deliveryId: string, workflowRunId: number, runAttempt: number, jobId: number): string {
  return `${deliveryId}:${workflowRunId}:${runAttempt}:${jobId}`
}

// ─── Monitor Status ─────────────────────────────────────────────────────

export interface MonitorStatus {
  running: boolean
  repo?: string
  pr?: number
  mode: PrMonitorMode
  active_repairs: number
  config: PrMonitorConfig
  recent_runs: RepairRun[]
}

// ─── Tool Response ──────────────────────────────────────────────────────

export interface PrMonitorToolResponse {
  ok: boolean
  action: PrMonitorAction
  message: string
  status?: MonitorStatus
  run?: RepairRun
}
