/**
 * Semantic Completion Gates
 *
 * Enforces completion gates that a model report cannot bypass.
 * All 6 gates must pass for a task run to be marked complete.
 */

export enum CompletionGate {
  ASSIGNMENTS_COMPLETE = "assignments_complete",
  EXACT_SHA_VERIFIED = "exact_sha_verified",
  CRITICAL_CRITERIA_PASSED = "critical_criteria_passed",
  CRITICAL_REQUIREMENTS_VERIFIED = "critical_requirements_verified",
  REQUIRED_VERIFICATION_PASSED = "required_verification_passed",
  MANDATORY_EVIDENCE_PRESENT = "mandatory_evidence_present",
}

export interface GateResult {
  gate: CompletionGate;
  passed: boolean;
  reasons?: string[];
  evidence?: Record<string, unknown>;
}

export interface CompletionGateInput {
  runId: string;
  currentSha: string;
  assignmentsComplete: boolean;
  verificationResults: readonly {
    id: string;
    runId: string;
    ruleId: string;
    ruleDescription: string;
    required: boolean;
    status: "pending" | "running" | "passed" | "failed" | "skipped";
    targetSha: string;
    evidenceIds: readonly string[];
  }[];
  acceptanceCriteria: readonly {
    id: string;
    description: string;
    priority: "critical" | "high" | "medium" | "low";
  }[];
  requirements: readonly {
    id: string;
    description: string;
    priority: "critical" | "high" | "medium" | "low";
  }[];
  evidenceItems: readonly {
    id: string;
    sha: string;
    runId: string;
    status: "current" | "archived";
    criterionIds: readonly string[];
  }[];
  /**
   * Evidence requirements derived from the contract.
   * Used by MANDATORY_EVIDENCE_PRESENT gate to verify all required evidence exists.
   */
  requiredEvidence?: readonly {
    type: string;
    description: string;
    path?: string;
  }[];
}

export const ALL_GATES: CompletionGate[] = [
  CompletionGate.ASSIGNMENTS_COMPLETE,
  CompletionGate.EXACT_SHA_VERIFIED,
  CompletionGate.CRITICAL_CRITERIA_PASSED,
  CompletionGate.CRITICAL_REQUIREMENTS_VERIFIED,
  CompletionGate.REQUIRED_VERIFICATION_PASSED,
  CompletionGate.MANDATORY_EVIDENCE_PRESENT,
];
