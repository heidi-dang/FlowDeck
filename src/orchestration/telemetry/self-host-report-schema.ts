import { z } from "zod/v4";

// ── Versioned contract ────────────────────────────────────────────────────────

export const SELF_HOST_REPORT_VERSION = "1.0.0" as const;
export const SCHEMA_VERSION = `self-host-report-${SELF_HOST_REPORT_VERSION}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Allows additional unknown properties on a schema for forward compatibility. */
function withExtras<T extends z.ZodObject<z.ZodRawShape>>(schema: T): T {
  return schema.catchall(z.unknown()) as T;
}

// ── Identity ─────────────────────────────────────────────────────────────────

export const IdentitySchema = withExtras(z.object({
  developer: z.string().optional(),
  taskId: z.string().optional(),
  phase: z.string().optional(),
  campaignId: z.string().optional(),
  mainSessionId: z.string().optional(),
  childSessionIds: z.array(z.string()).optional(),
  branch: z.string().optional(),
  baseSha: z.string().optional(),
  startingSha: z.string().optional(),
  finalLocalSha: z.string().optional(),
  finalRemoteSha: z.string().optional(),
  pr: z.string().optional(),
  flowdeckHarnessIdentity: z.string().optional(),
  candidateIdentity: z.string().optional(),
}));

// ── Orchestration ─────────────────────────────────────────────────────────────

export const StageDurationSchema = withExtras(z.object({
  stage: z.string(),
  startMs: z.number(),
  endMs: z.number().optional(),
  durationMs: z.number().optional(),
}));

export const SpecialistSchema = withExtras(z.object({
  id: z.string(),
  name: z.string().optional(),
  role: z.string().optional(),
  ownedStages: z.array(z.string()).optional(),
}));

export const DelegationReasonSchema = withExtras(z.object({
  specialistId: z.string().optional(),
  reason: z.string(),
  timestamp: z.number(),
}));

export const CheckpointSchema = withExtras(z.object({
  id: z.string(),
  name: z.string(),
  timestamp: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}));

export const DecisionSchema = withExtras(z.object({
  id: z.string(),
  type: z.string(),
  rationale: z.string().optional(),
  timestamp: z.number(),
}));

export const ContextRecordSchema = withExtras(z.object({
  id: z.string(),
  type: z.string(),
  content: z.string().optional(),
  timestamp: z.number(),
}));

export const GuardBlockSchema = withExtras(z.object({
  id: z.string(),
  type: z.string(),
  triggeredAt: z.number(),
  resolved: z.boolean(),
  resolution: z.string().optional(),
}));

export const RecoveryAttemptSchema = withExtras(z.object({
  id: z.string(),
  stage: z.string(),
  attemptNumber: z.number(),
  success: z.boolean(),
  error: z.string().optional(),
  timestamp: z.number(),
}));

export const StageDeviationSchema = withExtras(z.object({
  stage: z.string(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  reason: z.string().optional(),
}));

export const OrchestrationSchema = withExtras(z.object({
  strategy: z.string().optional(),
  stageOrder: z.array(z.string()).optional(),
  stageDurations: z.array(StageDurationSchema).optional(),
  specialists: z.array(SpecialistSchema).optional(),
  ownership: z.record(z.string(), z.string()).optional(),
  delegationReasons: z.array(DelegationReasonSchema).optional(),
  checkpoints: z.array(CheckpointSchema).optional(),
  decisions: z.array(DecisionSchema).optional(),
  contextRecords: z.array(ContextRecordSchema).optional(),
  guardBlocks: z.array(GuardBlockSchema).optional(),
  recoveryAttempts: z.array(RecoveryAttemptSchema).optional(),
  stageDeviations: z.array(StageDeviationSchema).optional(),
}));

// ── Token / Model Metrics ────────────────────────────────────────────────────

export const ProviderTokenMetricsSchema = withExtras(z.object({
  provider: z.string(),
  modelIdentifier: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  cacheReads: z.number().optional(),
  cacheWrites: z.number().optional(),
  estimatedCostUsd: z.number().optional(),
  contextWindowSize: z.number().optional(),
  compactions: z.number().optional(),
  duplicatedContextEstimate: z.number().optional(),
}));

export const TokenMetricsSchema = withExtras(z.object({
  provider: z.string().optional(),
  modelIdentifier: z.string().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
  cacheReads: z.number().optional(),
  cacheWrites: z.number().optional(),
  estimatedCostUsd: z.number().optional(),
  contextWindowSize: z.number().optional(),
  compactions: z.number().optional(),
  duplicatedContextEstimate: z.number().optional(),
}));

export const SpecialistTokenMetricsSchema = withExtras(z.object({
  specialistId: z.string().optional(),
  specialistName: z.string().optional(),
  heidi: TokenMetricsSchema.optional(),
  perSpecialist: z.array(TokenMetricsSchema).optional(),
}));

// ── Tool Metrics ─────────────────────────────────────────────────────────────

export const ToolCallMetricsSchema = withExtras(z.object({
  toolName: z.string().optional(),
  totalCalls: z.number().optional(),
  successfulCalls: z.number().optional(),
  failedCalls: z.number().optional(),
  blockedCalls: z.number().optional(),
  retries: z.number().optional(),
  cancellations: z.number().optional(),
}));

export const SlowestToolSchema = withExtras(z.object({
  toolName: z.string(),
  totalTimeMs: z.number(),
  callCount: z.number(),
}));

export const ToolMetricsSchema = withExtras(z.object({
  totalCalls: z.number().optional(),
  successfulCalls: z.number().optional(),
  failedCalls: z.number().optional(),
  blockedCalls: z.number().optional(),
  retries: z.number().optional(),
  cancellations: z.number().optional(),
  nativeFdxCalls: z.number().optional(),
  fallbackCalls: z.number().optional(),
  cacheHits: z.number().optional(),
  cacheMisses: z.number().optional(),
  batchedOperations: z.number().optional(),
  slowestTools: z.array(SlowestToolSchema).optional(),
  redundantCalls: z.number().optional(),
  duplicatedQueries: z.number().optional(),
  outputBytes: z.number().optional(),
  truncatedOutputs: z.number().optional(),
  perTool: z.array(ToolCallMetricsSchema).optional(),
}));

// ── Performance ───────────────────────────────────────────────────────────────

export const PerformanceMetricsSchema = withExtras(z.object({
  wallTimeMs: z.number().optional(),
  activeExecutionTimeMs: z.number().optional(),
  providerWaitTimeMs: z.number().optional(),
  toolWaitTimeMs: z.number().optional(),
  verificationTimeMs: z.number().optional(),
  ciWaitTimeMs: z.number().optional(),
  timeToFirstUsefulActionMs: z.number().optional(),
  specialistStartupLatencyMs: z.number().optional(),
  parallelismFactor: z.number().optional(),
  delegationBenefitMs: z.number().optional(),
  delegationOverheadMs: z.number().optional(),
  contextConstructionLatencyMs: z.number().optional(),
  completionGateLatencyMs: z.number().optional(),
}));

// ── Stability ─────────────────────────────────────────────────────────────────

export const StabilityMetricsSchema = withExtras(z.object({
  crashes: z.number().optional(),
  unhandledErrors: z.number().optional(),
  timeouts: z.number().optional(),
  hangs: z.number().optional(),
  orphanedSpecialists: z.number().optional(),
  duplicateChildCorrelation: z.number().optional(),
  missingChildCorrelation: z.number().optional(),
  missedCheckpoints: z.number().optional(),
  failedCheckpointWrites: z.number().optional(),
  staleStateEvents: z.number().optional(),
  staleVerificationEvents: z.number().optional(),
  repeatedIdenticalFailedCommands: z.number().optional(),
  leakedLocks: z.number().optional(),
  unintendedFileChanges: z.number().optional(),
  cleanupFailures: z.number().optional(),
  dirtyTreeContamination: z.number().optional(),
  unresolvedGuardFailures: z.number().optional(),
  cancellationRecoveryFailures: z.number().optional(),
}));

// ── Comparison ────────────────────────────────────────────────────────────────

export const VsFrozenV103BaselineSchema = withExtras(z.object({
  wallTimeDeltaMs: z.number().optional(),
  tokenDelta: z.number().optional(),
  costDeltaUsd: z.number().optional(),
  stabilityIncidents: z.number().optional(),
}));

export const VsPreviousComparableTaskSchema = withExtras(z.object({
  taskId: z.string().optional(),
  wallTimeDeltaMs: z.number().optional(),
  tokenDelta: z.number().optional(),
  costDeltaUsd: z.number().optional(),
}));

export const VsMilestoneTargetSchema = withExtras(z.object({
  targetWallTimeMs: z.number().optional(),
  targetCostUsd: z.number().optional(),
  targetTokenBudget: z.number().optional(),
  achieved: z.boolean().optional(),
}));

export const VsCandidateBuildSchema = withExtras(z.object({
  candidateSha: z.string().optional(),
  wallTimeDeltaMs: z.number().optional(),
  tokenDelta: z.number().optional(),
  costDeltaUsd: z.number().optional(),
}));

export const ComparisonSchema = withExtras(z.object({
  vsFrozenV103Baseline: VsFrozenV103BaselineSchema.optional(),
  vsPreviousComparableTask: VsPreviousComparableTaskSchema.optional(),
  vsMilestoneTarget: VsMilestoneTargetSchema.optional(),
  vsCandidateBuild: VsCandidateBuildSchema.optional(),
}));

// ── Final Verdict ─────────────────────────────────────────────────────────────

export const RatingSchema = withExtras(z.object({
  implementation: z.number().min(1).max(5).optional(),
  executionQuality: z.number().min(1).max(5).optional(),
  performance: z.number().min(1).max(5).optional(),
  stability: z.number().min(1).max(5).optional(),
  notes: z.string().optional(),
}));

export const FinalVerdictSchema = withExtras(z.object({
  implementationReadiness: z.number().min(1).max(5).optional(),
  executionQuality: z.number().min(1).max(5).optional(),
  performanceRating: z.number().min(1).max(5).optional(),
  stabilityRating: z.number().min(1).max(5).optional(),
  overallPass: z.boolean().optional(),
  summary: z.string().optional(),
  recommendations: z.array(z.string()).optional(),
  ratings: RatingSchema.optional(),
}));

// ── Self-Host Report ──────────────────────────────────────────────────────────

export const SelfHostReportSchema = withExtras(z.object({
  schemaVersion: z.string(),
  generatedAt: z.string(),
  identity: IdentitySchema.optional(),
  orchestration: OrchestrationSchema.optional(),
  tokenMetrics: SpecialistTokenMetricsSchema.optional(),
  toolMetrics: ToolMetricsSchema.optional(),
  performance: PerformanceMetricsSchema.optional(),
  stability: StabilityMetricsSchema.optional(),
  comparison: ComparisonSchema.optional(),
  finalVerdict: FinalVerdictSchema.optional(),
}));

// ── Types ─────────────────────────────────────────────────────────────────────

export type Identity = z.infer<typeof IdentitySchema>;
export type Orchestration = z.infer<typeof OrchestrationSchema>;
export type TokenMetrics = z.infer<typeof TokenMetricsSchema>;
export type SpecialistTokenMetrics = z.infer<typeof SpecialistTokenMetricsSchema>;
export type ToolMetrics = z.infer<typeof ToolMetricsSchema>;
export type PerformanceMetrics = z.infer<typeof PerformanceMetricsSchema>;
export type StabilityMetrics = z.infer<typeof StabilityMetricsSchema>;
export type Comparison = z.infer<typeof ComparisonSchema>;
export type FinalVerdict = z.infer<typeof FinalVerdictSchema>;
export type Rating = z.infer<typeof RatingSchema>;
export type SelfHostReport = z.infer<typeof SelfHostReportSchema>;

// ── Validation helper ────────────────────────────────────────────────────────

export function validateSelfHostReport(data: unknown): SelfHostReport {
  return SelfHostReportSchema.parse(data);
}

export function isValidSelfHostReport(data: unknown): data is SelfHostReport {
  return SelfHostReportSchema.safeParse(data).success;
}

export function createEmptyReport(): SelfHostReport {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
  };
}
