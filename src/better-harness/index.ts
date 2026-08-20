// Better Harness — Complete Backend
// Phase 3-6 implementation

// Contracts
export { HarnessDimensionEnum, HarnessPriorityEnum, HarnessFindingStatusEnum, HarnessFixVehicleEnum, HarnessRunStatusEnum, HarnessCollectorCategoryEnum, CollectorNameEnum } from "./contracts/common";
export type { HarnessDimension, HarnessPriority, HarnessFindingStatus, HarnessFixVehicle, HarnessRunStatus, HarnessCollectorCategory, CollectorName } from "./contracts/common";
export { HarnessEvidenceSchema, HarnessFindingSchema, HarnessDimensionScoreSchema, HarnessReportSchema } from "./contracts/report";
export type { HarnessEvidence, HarnessFinding, HarnessDimensionScore, HarnessReport } from "./contracts/report";
export { HarnessRunProgressSchema } from "./contracts/progress";
export type { HarnessRunProgress } from "./contracts/progress";
// Workspace
export { captureWorkspaceSnapshot } from "./workspace/workspace-snapshot";
export type { WorkspaceSnapshot } from "./workspace/workspace-snapshot";
export { getProjectIdentity } from "./workspace/project-identity";
export type { ProjectIdentity } from "./workspace/project-identity";

// Collectors
export { collectCustomizationEvidence } from "./collectors/customization-collector";
export { collectFoundationEvidence } from "./collectors/foundation-collector";
export { collectSessionEvidence } from "./collectors/session-collector";
export { runAllCollectors } from "./collectors/collector-runner";
export type { CollectorResult } from "./collectors/collector-runner";

// Evidence
export { generateEvidenceFingerprint } from "./evidence/evidence-fingerprint";
export { normalizeEvidence } from "./evidence/evidence-normalizer";
export type { RawCollectorEvidence } from "./evidence/evidence-normalizer";
export { deduplicateEvidence } from "./evidence/evidence-deduplicator";

// Analyzers
export { analyzeTaskUnderstanding } from "./analyzers/task-understanding";
export { analyzeControlledExecution } from "./analyzers/controlled-execution";
export { analyzeChangeValidation } from "./analyzers/change-validation";
export { analyzeReliableDelivery } from "./analyzers/reliable-delivery";
export { analyzeLearningCapture } from "./analyzers/learning-capture";
export { synthesizeFindings } from "./analyzers/finding-synthesizer";

// Scoring
export { scoreDimension } from "./scoring/dimension-scoring";
export { calculateOverallScore, getScoreTrend } from "./scoring/overall-scoring";
export { SCORING_VERSION, formatScoreWithVersion } from "./scoring/scoring-version";

// OpenCode
export { readSessionRecords } from "./opencode/session-reader";
export type { SessionRecord, SessionEvent } from "./opencode/session-reader";
export { analyzeSessions } from "./opencode/session-analyzer";
export type { SessionAnalysis } from "./opencode/session-analyzer";
export { createRepairSession, generateRestrictedRepairPrompt } from "./opencode/repair-session";
export type { RestrictedRepairPromptOptions } from "./opencode/repair-session";
export { buildRepairPrompt } from "./opencode/repair-prompt";
export type { RepairPromptConfig } from "./opencode/repair-prompt";
export { executeValidation } from "./opencode/validation-executor";
export type { ValidationResult } from "./opencode/validation-executor";

// Persistence
export { getFlowDeckStateDir, setFlowDeckStateDir, resetFlowDeckStateDir, getProjectStoreDir, atomicWriteFile, readJsonFile } from "./persistence/harness-store";
export { saveRun, loadRun, listRuns } from "./persistence/run-store";
export type { StoredRun } from "./persistence/run-store";
export { saveReport, loadReport, listReports } from "./persistence/report-store";
export { saveFindingIndex, loadFindingIndex, getActiveFindings } from "./persistence/finding-store";
export type { FindingIndex } from "./persistence/finding-store";
export { saveIgnoredFinding, loadIgnoredFindings, isFindingIgnored } from "./persistence/ignored-finding-store";
export type { IgnoredFinding } from "./persistence/ignored-finding-store";
export { saveRepairSession, loadRepairSession, listRepairSessions } from "./persistence/repair-session-store";
export type { StoredRepairSession } from "./persistence/repair-session-store";

// Runtime
export { HarnessRuntime } from "./runtime/harness-runtime";
export type { HarnessRuntimeConfig } from "./runtime/harness-runtime";
export { RunCoordinator } from "./runtime/run-coordinator";
export type { RunConfig, RunState } from "./runtime/run-coordinator";
export { EventBus } from "./runtime/event-bus";
export type { HarnessEvent, HarnessEventType, EventHandler } from "./runtime/event-bus";
export { cancelRun, isRunCancelled, clearCancellation } from "./runtime/run-cancellation";
export { registry } from "./runtime/runtime-registry";

// Transport
export { routeRequest } from "./transport/router";
export type { RouteHandler, RouteResponse } from "./transport/router";
export { createCorsHeaders, DEFAULT_CORS_CONFIG } from "./transport/cors";
export type { CorsConfig } from "./transport/cors";
export { createAuthCheck } from "./transport/authentication";
export type { AuthConfig } from "./transport/authentication";
export { setRequestContext, getRequestContext, clearRequestContext } from "./transport/request-context";
export type { RequestContext } from "./transport/request-context";

// Verification
export { inspectDiff } from "./verification/diff-inspector";
export type { DiffEntry, DiffInspectionResult } from "./verification/diff-inspector";
export { runRequirements } from "./verification/requirement-runner";
export type { RequirementResult } from "./verification/requirement-runner";
export { verifyFinding } from "./verification/finding-verifier";
export type { FindingVerification, VerificationStatus } from "./verification/finding-verifier";
export { detectRegressions } from "./verification/regression-detector";
export type { RegressionResult } from "./verification/regression-detector";
export { generateLearningProposal } from "./verification/learning-capture";
export type { LearningProposal } from "./verification/learning-capture";
