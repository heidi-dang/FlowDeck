import type { CommandDefinition } from "../domain/command-definition";

export const TASK_START_COMMAND: CommandDefinition = {
  id: "task/start",
  version: 1,
  description: "Start a task run and initiate planning/execution",
  aliases: ["fd-task", "task"],
  inputSchema: {
    type: "object",
    properties: {
      taskDescription: { type: "string", required: true },
      isTrivial: { type: "boolean" },
    },
    required: ["taskDescription"],
  },
  strategy: "planned",
  capabilities: { requiresWorktree: true },
  planningPolicy: { requiresPlan: true },
  executionPolicy: { timeoutMs: 60000 },
  verificationPolicy: { requiresPassedVerification: true },
  completionPolicy: { requireAllAssignmentsCompleted: true },
  retryPolicy: { maxRetries: 3, backoffMs: 1000 },
  tokenPolicy: { maxTokenBudget: 100000 },
};

export const PLAN_COMMAND: CommandDefinition = {
  id: "plan",
  version: 1,
  description: "Create or refresh an execution plan",
  aliases: ["fd-plan"],
  inputSchema: {
    type: "object",
    properties: {
      taskRunId: { type: "string", required: true },
    },
    required: ["taskRunId"],
  },
  strategy: "planned",
  capabilities: {},
  planningPolicy: { requiresPlan: true },
  executionPolicy: { timeoutMs: 30000 },
  verificationPolicy: { requiresPassedVerification: false },
  completionPolicy: { requireAllAssignmentsCompleted: false },
  retryPolicy: { maxRetries: 2, backoffMs: 500 },
  tokenPolicy: { maxTokenBudget: 50000 },
};

export const EXECUTE_COMMAND: CommandDefinition = {
  id: "execute",
  version: 1,
  description: "Execute active assignments in plan",
  aliases: ["fd-execute"],
  inputSchema: {
    type: "object",
    properties: {
      taskRunId: { type: "string", required: true },
    },
    required: ["taskRunId"],
  },
  strategy: "delegated",
  capabilities: { requiresWorktree: true },
  planningPolicy: { requiresPlan: true },
  executionPolicy: { timeoutMs: 120000 },
  verificationPolicy: { requiresPassedVerification: true },
  completionPolicy: { requireAllAssignmentsCompleted: true },
  retryPolicy: { maxRetries: 3, backoffMs: 1000 },
  tokenPolicy: { maxTokenBudget: 150000 },
};

export const VERIFY_COMMAND: CommandDefinition = {
  id: "verify",
  version: 1,
  description: "Run verification gates against acceptance criteria",
  aliases: ["fd-verify"],
  inputSchema: {
    type: "object",
    properties: {
      taskRunId: { type: "string", required: true },
      sha: { type: "string" },
    },
    required: ["taskRunId"],
  },
  strategy: "simple",
  capabilities: {},
  planningPolicy: { requiresPlan: false },
  executionPolicy: { timeoutMs: 60000 },
  verificationPolicy: { requiresPassedVerification: true, enforceExactSha: true },
  completionPolicy: { requireEvidenceCurrent: true },
  retryPolicy: { maxRetries: 2, backoffMs: 500 },
  tokenPolicy: { maxTokenBudget: 30000 },
};

export const REVIEW_AUDIT_COMMAND: CommandDefinition = {
  id: "review/audit",
  version: 1,
  description: "Conduct review or audit of task execution",
  aliases: ["fd-review", "review", "audit"],
  inputSchema: {
    type: "object",
    properties: {
      taskRunId: { type: "string", required: true },
    },
    required: ["taskRunId"],
  },
  strategy: "audit",
  capabilities: {},
  planningPolicy: { requiresPlan: false },
  executionPolicy: { timeoutMs: 45000 },
  verificationPolicy: { requiresPassedVerification: false },
  completionPolicy: {},
  retryPolicy: { maxRetries: 1, backoffMs: 1000 },
  tokenPolicy: { maxTokenBudget: 40000 },
};

export const RESUME_RECOVER_COMMAND: CommandDefinition = {
  id: "resume/recover",
  version: 1,
  description: "Resume or recover interrupted command execution",
  aliases: ["fd-resume", "fd-checkpoint", "resume", "recover"],
  inputSchema: {
    type: "object",
    properties: {
      taskRunId: { type: "string", required: true },
    },
    required: ["taskRunId"],
  },
  strategy: "recovery",
  capabilities: {},
  planningPolicy: { requiresPlan: false },
  executionPolicy: { timeoutMs: 60000 },
  verificationPolicy: { requiresPassedVerification: false },
  completionPolicy: {},
  retryPolicy: { maxRetries: 3, backoffMs: 1000 },
  tokenPolicy: { maxTokenBudget: 60000 },
};

export const STATUS_COMMAND: CommandDefinition = {
  id: "status",
  version: 1,
  description: "Query status of invocation or task run",
  aliases: ["fd-status"],
  inputSchema: {
    type: "object",
    properties: {
      taskRunId: { type: "string" },
      invocationId: { type: "string" },
    },
  },
  strategy: "simple",
  capabilities: {},
  planningPolicy: { requiresPlan: false },
  executionPolicy: { timeoutMs: 10000 },
  verificationPolicy: { requiresPassedVerification: false },
  completionPolicy: {},
  retryPolicy: { maxRetries: 1, backoffMs: 100 },
  tokenPolicy: { maxTokenBudget: 10000 },
};

export const COMPLETE_COMMAND: CommandDefinition = {
  id: "complete",
  version: 1,
  description: "Finalize task run through completion engine",
  aliases: ["fd-done", "complete"],
  inputSchema: {
    type: "object",
    properties: {
      taskRunId: { type: "string", required: true },
    },
    required: ["taskRunId"],
  },
  strategy: "simple",
  capabilities: {},
  planningPolicy: { requiresPlan: false },
  executionPolicy: { timeoutMs: 30000 },
  verificationPolicy: { requiresPassedVerification: true },
  completionPolicy: { requireAllAssignmentsCompleted: true, requireEvidenceCurrent: true, requireAcceptanceCriteriaMet: true },
  retryPolicy: { maxRetries: 2, backoffMs: 500 },
  tokenPolicy: { maxTokenBudget: 20000 },
};

export const CORE_M9_COMMANDS: CommandDefinition[] = [
  TASK_START_COMMAND,
  PLAN_COMMAND,
  EXECUTE_COMMAND,
  VERIFY_COMMAND,
  REVIEW_AUDIT_COMMAND,
  RESUME_RECOVER_COMMAND,
  STATUS_COMMAND,
  COMPLETE_COMMAND,
];
