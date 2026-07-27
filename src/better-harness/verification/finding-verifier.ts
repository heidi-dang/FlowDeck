import type { HarnessFinding } from "../contracts/report";
import { inspectDiff, type DiffEntry } from "./diff-inspector";
import { runRequirements, type RequirementResult } from "./requirement-runner";

export type VerificationStatus = "fixed" | "pending" | "regressed" | "ignored";

export interface FindingVerification {
  findingId: string;
  status: VerificationStatus;
  diffResult: { changedFiles: DiffEntry[]; violations: string[]; allowed: boolean };
  requirementResults: RequirementResult[];
  verifiedAt: string;
}

export function verifyFinding(
  finding: HarnessFinding,
  changedFiles: DiffEntry[],
  cwd: string,
): FindingVerification {
  const diffResult = inspectDiff(changedFiles, finding.allowedPaths);
  const requirementResults = runRequirements(finding.validationRequirements, cwd);
  const now = new Date().toISOString();

  let status: VerificationStatus = "pending";

  if (diffResult.allowed && requirementResults.every((r) => r.passed)) {
    status = "fixed";
  } else if (diffResult.violations.length > 0) {
    status = "pending";
  } else if (!requirementResults.every((r) => r.passed)) {
    status = "pending";
  }

  return {
    findingId: finding.id,
    status,
    diffResult,
    requirementResults,
    verifiedAt: now,
  };
}
