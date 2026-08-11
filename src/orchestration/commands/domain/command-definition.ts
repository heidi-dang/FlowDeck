export interface CommandInputSchema {
  type: "object";
  properties: Record<string, { type: string; description?: string; required?: boolean }>;
  required?: string[];
}

export type CommandExecutionStrategy = "simple" | "planned" | "delegated" | "audit" | "recovery";

export interface CapabilityRequirements {
  allowedTools?: string[];
  requiresWorktree?: boolean;
  requiresGit?: boolean;
  requiredPermissions?: string[];
}

export interface PlanningPolicy {
  requiresPlan?: boolean;
  allowAutonomousRouting?: boolean;
  allowedStrategies?: CommandExecutionStrategy[];
}

export interface ExecutionPolicy {
  timeoutMs?: number;
  maxParallelWorkstreams?: number;
  allowWorktreeIsolation?: boolean;
}

export interface VerificationPolicy {
  requiresPassedVerification?: boolean;
  requiredEvidenceTypes?: string[];
  enforceExactSha?: boolean;
}

export interface CompletionPolicy {
  requireAllAssignmentsCompleted?: boolean;
  requireEvidenceCurrent?: boolean;
  requireAcceptanceCriteriaMet?: boolean;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  retryableErrors?: string[];
}

export interface TokenPolicy {
  maxTokenBudget?: number;
  reservationCeiling?: number;
  allowContextCompaction?: boolean;
}

export interface CommandDefinition<TInput = Record<string, unknown>, _TOutput = Record<string, unknown>> {
  id: string;
  version: number;
  description: string;
  aliases?: string[];
  inputSchema?: CommandInputSchema;
  strategy: CommandExecutionStrategy;
  capabilities: CapabilityRequirements;
  planningPolicy: PlanningPolicy;
  executionPolicy: ExecutionPolicy;
  verificationPolicy: VerificationPolicy;
  completionPolicy: CompletionPolicy;
  retryPolicy: RetryPolicy;
  tokenPolicy: TokenPolicy;
  outputSchema?: Record<string, unknown>;
  validateInput?: (input: unknown) => { valid: boolean; errors?: Array<{ field: string; reason: string }> };
  compileHandler?: (invocation: CommandInvocation<TInput>) => Promise<ExecutableCommandPlan>;
}

export type CommandInvocationStatus =
  | "pending"
  | "accepted"
  | "running"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export interface CommandInvocation<TInput = Record<string, unknown>> {
  invocationId: string;
  commandId: string;
  commandVersion: number;
  idempotencyKey: string;
  status: CommandInvocationStatus;
  input: TInput;
  taskRunId?: string;
  contractId?: string;
  planId?: string;
  workstreamIds?: string[];
  retryCount: number;
  requestFingerprint?: string;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: { code: string; message: string; details?: unknown };
}

export interface ExecutableCommandPlan {
  commandId: string;
  commandVersion: number;
  invocationId: string;
  strategy: CommandExecutionStrategy;
  taskRunId: string;
  contractId: string;
  workstreams: Array<{
    id: string;
    name: string;
    agentRole: string;
    dependencies: string[];
  }>;
  verificationRequirements: VerificationPolicy;
  tokenBudget: TokenPolicy;
}

export interface CommandResult<TData = Record<string, unknown>> {
  invocationId: string;
  commandId: string;
  commandVersion: number;
  taskRunId?: string;
  status: CommandInvocationStatus;
  summary: string;
  data?: TData;
  evidenceIds?: string[];
  verificationPassed?: boolean;
  completionDecisionId?: string;
  error?: { code: string; message: string; details?: unknown };
  timestamps: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
  };
}
