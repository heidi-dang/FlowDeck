export interface VerificationDashboardProjection {
  runId: string;
  totalChecks: number;
  passed: number;
  failed: number;
  error: number;
  skipped: number;
  pending: number;
  passRate: number;
  checks: Array<{
    id: string;
    checkType: string;
    status: string;
    result: string;
    assignmentId?: string;
    completedAt?: string;
  }>;
}

export function buildVerificationDashboard(runId: string, verifications: Array<{
  id: string; status: string; checkType: string; result: string;
  assignmentId?: string; completedAt?: string;
}>): VerificationDashboardProjection {
  const passed = verifications.filter(v => v.status === "passed").length;
  const failed = verifications.filter(v => v.status === "failed").length;
  const error = verifications.filter(v => v.status === "error").length;
  const skipped = verifications.filter(v => v.status === "skipped").length;
  const pending = verifications.filter(v => v.status === "pending" || v.status === "in_progress").length;
  const completed = passed + failed;

  return {
    runId,
    totalChecks: verifications.length,
    passed,
    failed,
    error,
    skipped,
    pending,
    passRate: completed > 0 ? Math.round((passed / completed) * 100) : 0,
    checks: verifications.map(v => ({
      id: v.id, checkType: v.checkType, status: v.status,
      result: v.result, assignmentId: v.assignmentId, completedAt: v.completedAt,
    })),
  };
}
