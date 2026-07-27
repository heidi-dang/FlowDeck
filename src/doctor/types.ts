/**
 * Environment Doctor — shared types
 *
 * Every check, recommendation, profile, and report uses these types.
 * The doctor engine is a pure function pipeline with no AI dependency.
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
}

export interface DoctorOptions {
  json?: boolean
  applyRecommended?: boolean
  strict?: boolean
  verbose?: boolean
  profile?: string
  nonInteractive?: boolean
}
