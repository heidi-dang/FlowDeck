import { z } from "zod/v4";

export const RepairSessionStatusEnum = z.enum([
  "pending",
  "in-progress",
  "completed",
  "failed",
  "cancelled",
]);

export const RepairSessionSchema = z.object({
  id: z.string().min(1),
  findingId: z.string().min(1),
  projectId: z.string().min(1),
  serverKey: z.string().min(1),
  status: RepairSessionStatusEnum,
  openCodeSessionId: z.string().optional(),
  cause: z.string().min(1),
  expectedOutput: z.string().min(1),
  allowedPaths: z.array(z.string()),
  validationRequirements: z.string().min(1),
  acceptanceCriteria: z.string().min(1),
  createdAt: z.string().min(1),
  completedAt: z.string().optional(),
  result: z.unknown().optional(),
}).strict();

export const VerificationResultSchema = z.object({
  findingId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(["passed", "failed", "pending"]),
  diffInspection: z.string().min(1),
  validationResults: z.array(z.unknown()),
  evidenceChanged: z.boolean(),
  verifiedAt: z.string().min(1),
}).strict();

export const LearningCaptureProposalSchema = z.object({
  findingId: z.string().min(1),
  title: z.string().min(1),
  recommendation: z.string().min(1),
  rationale: z.string().min(1),
  proposedContent: z.string().optional(),
  targetPath: z.string().optional(),
  requiresApproval: z.boolean(),
  createdAt: z.string().min(1),
}).strict();

export const SSEClientEventSchema = z.object({
  eventId: z.string().min(1),
  runId: z.string().min(1),
  projectId: z.string().min(1),
  eventType: z.enum([
    "run-started",
    "run-progress",
    "run-completed",
    "run-failed",
    "finding-created",
    "finding-updated",
    "repair-session-created",
    "repair-session-completed",
    "verification-completed",
    "error",
  ]),
  sequence: z.number().int().nonnegative(),
  timestamp: z.string().min(1),
  payload: z.unknown(),
}).strict();

export const WorkspaceSnapshotSchema = z.object({
  projectId: z.string().min(1),
  projectDir: z.string().min(1),
  repoName: z.string().optional(),
  branch: z.string().optional(),
  revision: z.string().optional(),
  isDirty: z.boolean(),
  languages: z.array(z.string()),
  packageManager: z.string().optional(),
  isMonorepo: z.boolean(),
  buildCommands: z.array(z.string()),
  testCommands: z.array(z.string()),
  lintCommands: z.array(z.string()),
  hasCI: z.boolean(),
  hasOpenCodeConfig: z.boolean(),
  hasFlowDeckConfig: z.boolean(),
}).strict();