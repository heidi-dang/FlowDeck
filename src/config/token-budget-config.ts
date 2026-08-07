/**
 * Token Budget Configuration
 *
 * Single authoritative source for hierarchical token-budget limits.
 *
 * Profiles provide conservative safe defaults. Every value is overridable
 * through the FlowDeck config (`tokenBudget`) or environment variables.
 * Validation rejects negative/zero/NaN/overflow values and guarantees a
 * child ceiling can never exceed a stricter parent ceiling.
 *
 * No hostname, absolute path, model, or token is hardcoded here.
 */

export type BudgetProfileName = "small" | "normal" | "audit" | "deep-audit"

export interface TokenBudgetProfile {
  name: BudgetProfileName
  /** Run-level ceiling — parent + every descendant + retries + reviewer/tester/recovery/summarisation. */
  runTotal: number
  /** Per-child ceiling — independently enforced for each delegated session. */
  childTotal: number
  /** Maximum concurrent/sequential delegations per run. */
  maxDelegations: number
  /** Maximum automatic model retries per request. */
  autoRetry: number
}

export interface TokenBudgetOverrides {
  enabled?: boolean
  profile?: BudgetProfileName
  runTotal?: number
  childTotal?: number
  maxDelegations?: number
  autoRetry?: number
  /** Fraction of runTotal at which a single warning fires. Default 0.8. */
  warningThreshold?: number
  /** Fraction of runTotal at which the run hard-stops. Default 1.0. */
  hardStopThreshold?: number
  /** Upper bound on a single request's estimated input reservation. */
  maxRequestInputTokens?: number
  /** Upper bound on a single request's reserved output. */
  maxRequestOutputTokens?: number
  /** Tool output larger than this (chars) is externalised/compacted. */
  maxToolOutputChars?: number
  /** Conversation snapshot larger than this (tokens) triggers compaction. */
  compactThresholdTokens?: number
  /** Directory for durable token-usage accounting. */
  persistDir?: string
}

export interface ResolvedTokenBudgetConfig {
  enabled: boolean
  profile: BudgetProfileName
  runTotal: number
  childTotal: number
  maxDelegations: number
  autoRetry: number
  warningThreshold: number
  hardStopThreshold: number
  maxRequestInputTokens: number
  maxRequestOutputTokens: number
  maxToolOutputChars: number
  compactThresholdTokens: number
  persistDir: string
}

export const BUDGET_PROFILES: Record<BudgetProfileName, TokenBudgetProfile> = {
  small: { name: "small", runTotal: 250_000, childTotal: 80_000, maxDelegations: 1, autoRetry: 1 },
  normal: { name: "normal", runTotal: 600_000, childTotal: 180_000, maxDelegations: 3, autoRetry: 1 },
  audit: { name: "audit", runTotal: 1_500_000, childTotal: 350_000, maxDelegations: 4, autoRetry: 1 },
  "deep-audit": { name: "deep-audit", runTotal: 3_000_000, childTotal: 600_000, maxDelegations: 5, autoRetry: 1 },
}

export const DEFAULT_PROFILE: BudgetProfileName = "normal"

export const DEFAULT_WARNING_THRESHOLD = 0.8
export const DEFAULT_HARD_STOP_THRESHOLD = 1.0
export const DEFAULT_MAX_REQUEST_INPUT = 200_000
export const DEFAULT_MAX_REQUEST_OUTPUT = 32_000
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 8_000
export const DEFAULT_COMPACT_THRESHOLD_TOKENS = 120_000

export class TokenBudgetConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TokenBudgetConfigError"
  }
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v)
}

function assertNonNegativeInt(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TokenBudgetConfigError(`${label} must be a non-negative integer, got ${value}`)
  }
}

function assertPositive(value: number, label: string): void {
  if (!isFiniteNumber(value) || value <= 0) {
    throw new TokenBudgetConfigError(`${label} must be a positive finite number, got ${value}`)
  }
}

function assertFraction(value: number, label: string): void {
  if (!isFiniteNumber(value) || value <= 0 || value > 1) {
    throw new TokenBudgetConfigError(`${label} must be in (0, 1], got ${value}`)
  }
}

function envNumber(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return undefined
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new TokenBudgetConfigError(`Environment variable ${name} must be a finite number, got "${raw}"`)
  }
  return n
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return undefined
  const v = raw.toLowerCase()
  if (v === "1" || v === "true" || v === "yes") return true
  if (v === "0" || v === "false" || v === "no") return false
  throw new TokenBudgetConfigError(`Environment variable ${name} must be a boolean, got "${raw}"`)
}

function envProfile(): BudgetProfileName | undefined {
  const raw = process.env.FLOWDECK_TOKEN_BUDGET_PROFILE
  if (raw === undefined || raw === "") return undefined
  if (!(raw in BUDGET_PROFILES)) {
    throw new TokenBudgetConfigError(
      `FLOWDECK_TOKEN_BUDGET_PROFILE must be one of ${Object.keys(BUDGET_PROFILES).join(", ")}, got "${raw}"`,
    )
  }
  return raw as BudgetProfileName
}

/**
 * Resolve and validate the effective token-budget configuration.
 *
 * Precedence: explicit overrides > profile defaults > built-in defaults.
 * Environment variables override config values.
 *
 * @param overrides - user-supplied tokenBudget config (may be partial).
 */
export function resolveTokenBudgetConfig(overrides?: TokenBudgetOverrides): ResolvedTokenBudgetConfig {
  const profileName = envProfile() ?? overrides?.profile ?? DEFAULT_PROFILE
  const profile = BUDGET_PROFILES[profileName]

  const enabled = envBool("FLOWDECK_TOKEN_BUDGET_ENABLED") ?? overrides?.enabled ?? true

  let runTotal = envNumber("FLOWDECK_TOKEN_BUDGET_RUN_TOTAL") ?? overrides?.runTotal ?? profile.runTotal
  let childTotal = envNumber("FLOWDECK_TOKEN_BUDGET_CHILD_TOTAL") ?? overrides?.childTotal ?? profile.childTotal
  let maxDelegations = envNumber("FLOWDECK_TOKEN_BUDGET_DELEGATIONS") ?? overrides?.maxDelegations ?? profile.maxDelegations
  let autoRetry = envNumber("FLOWDECK_TOKEN_BUDGET_RETRY") ?? overrides?.autoRetry ?? profile.autoRetry

  assertPositive(runTotal, "runTotal")
  assertPositive(childTotal, "childTotal")
  assertNonNegativeInt(maxDelegations, "maxDelegations")
  assertNonNegativeInt(autoRetry, "autoRetry")

  // A child ceiling must never exceed a stricter parent ceiling.
  if (childTotal > runTotal) {
    throw new TokenBudgetConfigError(
      `childTotal (${childTotal}) must not exceed runTotal (${runTotal})`,
    )
  }

  const warningThreshold = envNumber("FLOWDECK_TOKEN_BUDGET_WARNING") ?? overrides?.warningThreshold ?? DEFAULT_WARNING_THRESHOLD
  const hardStopThreshold = envNumber("FLOWDECK_TOKEN_BUDGET_HARD_STOP") ?? overrides?.hardStopThreshold ?? DEFAULT_HARD_STOP_THRESHOLD
  assertFraction(warningThreshold, "warningThreshold")
  assertFraction(hardStopThreshold, "hardStopThreshold")
  if (warningThreshold > hardStopThreshold) {
    throw new TokenBudgetConfigError(
      `warningThreshold (${warningThreshold}) must not exceed hardStopThreshold (${hardStopThreshold})`,
    )
  }

  const maxRequestInputTokens = envNumber("FLOWDECK_TOKEN_BUDGET_MAX_REQUEST_INPUT") ?? overrides?.maxRequestInputTokens ?? DEFAULT_MAX_REQUEST_INPUT
  const maxRequestOutputTokens = envNumber("FLOWDECK_TOKEN_BUDGET_MAX_REQUEST_OUTPUT") ?? overrides?.maxRequestOutputTokens ?? DEFAULT_MAX_REQUEST_OUTPUT
  assertPositive(maxRequestInputTokens, "maxRequestInputTokens")
  assertPositive(maxRequestOutputTokens, "maxRequestOutputTokens")

  const maxToolOutputChars = envNumber("FLOWDECK_TOKEN_BUDGET_MAX_TOOL_OUTPUT") ?? overrides?.maxToolOutputChars ?? DEFAULT_MAX_TOOL_OUTPUT_CHARS
  const compactThresholdTokens = envNumber("FLOWDECK_TOKEN_BUDGET_COMPACT_THRESHOLD") ?? overrides?.compactThresholdTokens ?? DEFAULT_COMPACT_THRESHOLD_TOKENS
  assertPositive(maxToolOutputChars, "maxToolOutputChars")
  assertPositive(compactThresholdTokens, "compactThresholdTokens")

  const persistDir = overrides?.persistDir ?? ""

  return {
    enabled,
    profile: profileName,
    runTotal,
    childTotal,
    maxDelegations,
    autoRetry,
    warningThreshold,
    hardStopThreshold,
    maxRequestInputTokens,
    maxRequestOutputTokens,
    maxToolOutputChars,
    compactThresholdTokens,
    persistDir,
  }
}