/**
 * Environment Doctor & Repair Orchestrator — Domain Types
 */

export type CheckStatus = "pass" | "warning" | "error" | "info" | "skipped"
export type Severity = "critical" | "high" | "medium" | "low" | "info"
export type CheckCategory =
  | "runtime"
  | "repository"
  | "environment"
  | "mcp"
  | "plugin"
  | "lsp"
  | "hook"
  | "security"
  | "performance"
  | "configuration"
  | "fdx"
  | "browser"
  | "skills"
  | "heidi"
  | "filesystem"
  | "process"

export type DoctorCheckStatus = "healthy" | "warning" | "broken" | "blocked"
export type DoctorSeverity = "info" | "degraded" | "critical"
export type DoctorRepairability =
  | "automatic"
  | "requires-auth"
  | "requires-privilege"
  | "manual"
  | "not-applicable"

export interface CheckResult {
  id: string
  title: string
  category: CheckCategory
  severity: Severity
  status: CheckStatus
  detected: string
  expected: string
  recommendation: string
  autoFixAvailable: boolean
  docsUrl?: string

  // Authoritative health & repair extensions
  affectsRuntime?: boolean
  repairability?: DoctorRepairability
  evidence?: Record<string, unknown>
  remediation?: string
  repairAction?: string
}

export interface DoctorCheckResult extends CheckResult {
  affectsRuntime: boolean
  repairability: DoctorRepairability
  remediation: string
}

export interface DoctorReport {
  timestamp: string
  version: string
  checks: CheckResult[]
  scores: {
    environment: number
    security: number
    performance: number
    configuration: number
    overall: number
  }
  recommendations: Recommendation[]
  summary: {
    passed: number
    warnings: number
    errors: number
    info: number
    skipped: number
    total: number
  }
  profile: string
  repairableCount?: number
  requiresAuthCount?: number
  requiresPrivilegeCount?: number
  manualCount?: number
}

export interface Recommendation {
  id: string
  type: "required" | "recommended" | "optional" | "experimental"
  priority: number
  title: string
  description: string
  benefit: string
  risk: string
  estimatedImpact: "high" | "medium" | "low"
  autoFixAvailable: boolean
  autoFixCommand?: string
  checkIds: string[]
}

export interface DoctorProfile {
  name: string
  description: string
  enabledMcps: string[]
  enabledHooks: string[]
  runtimeRequirements: string[]
  recommendedSettings: Record<string, unknown>
}

export interface AutoFixResult {
  id: string
  description: string
  applied: boolean
  error?: string
  reverified?: boolean
}

export interface DoctorOptions {
  directory?: string
  json?: boolean
  fix?: boolean
  applyRecommended?: boolean
  dryRun?: boolean
  strict?: boolean
  verbose?: boolean
  profile?: string
  nonInteractive?: boolean
}

export interface RepairPlanItem {
  checkId: string
  title: string
  category: CheckCategory
  repairability: DoctorRepairability
  repairAction: string
  targetPath?: string
  requiresPrivilege: boolean
  requiresAuth: boolean
}

export interface RepairPlan {
  timestamp: string
  items: RepairPlanItem[]
  automaticItems: RepairPlanItem[]
  requiresAuthItems: RepairPlanItem[]
  requiresPrivilegeItems: RepairPlanItem[]
  manualItems: RepairPlanItem[]
}

export interface DoctorFixResult {
  timestamp: string
  initialReport: DoctorReport
  repairPlan: RepairPlan
  appliedFixes: AutoFixResult[]
  passesExecuted: number
  maxPasses: number
  terminatedReason: "all_repaired" | "max_passes_reached" | "no_progress" | "lock_failed" | "error"
  finalReport: DoctorReport
  healthy: boolean
}
