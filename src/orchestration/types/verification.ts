import { z } from "zod/v4";

export const VerificationStatus = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  PASSED: "passed",
  FAILED: "failed",
  SKIPPED: "skipped",
  ERROR: "error",
} as const;

export type VerificationStatus = (typeof VerificationStatus)[keyof typeof VerificationStatus];

export interface Evidence {
  id: string;
  type: string;
  description: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export interface EvidenceDTO {
  id: string;
  type: string;
  description: string;
}

export interface VerificationResult {
  id: string;
  runId: string;
  assignmentId?: string;
  contractId?: string;
  checkType: string;
  status: VerificationStatus;
  correlationId: string;
  causationId?: string;
  result?: string;
  evidenceIds?: string[];
  score?: number;
  details?: Record<string, unknown>;
  evidence?: Evidence[];
  error?: string;
  metadata?: Record<string, unknown>;
  /** Durable live-verification identity for the authoritative Run state. */
  stateVersion?: number;
  stateFingerprint?: string;
  targetSha?: string;
  isStale?: boolean;
  failureReasons?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface VerificationFilter {
  runId?: string;
  checkType?: string;
  status?: string;
  correlationId?: string;
}

export interface VerificationResultDTO {
  id: string;
  runId: string;
  checkType: string;
  status: string;
  correlationId: string;
  score?: number;
  createdAt: string;
}

export const VerificationFilterSchema = z.object({
  runId: z.string().optional(),
  checkType: z.string().optional(),
  status: z.string().optional(),
  correlationId: z.string().optional(),
});
