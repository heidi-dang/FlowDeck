export interface RunSummaryProjection {
  runId: string;
  status: string;
  runType: string;
  progressPercent: number;
  stage: string;
  duration: number | null; // ms
  assignmentCount: number;
  completedAssignmentCount: number;
  failedAssignmentCount: number;
  verificationCount: number;
  passedVerificationCount: number;
  failedVerificationCount: number;
  startedAt: string;
  completedAt?: string;
  errorMessage?: string;
}

export function buildRunSummaryProjection(data: {
  run: { id: string; status: string; runType: string; progressPercent: number; stage: string; startedAt: string; completedAt?: string; errorMessage?: string };
  assignments: Array<{ status: string }>;
  verifications: Array<{ status: string }>;
}): RunSummaryProjection {
  const start = new Date(data.run.startedAt).getTime();
  const end = data.run.completedAt ? new Date(data.run.completedAt).getTime() : Date.now();
  return {
    runId: data.run.id,
    status: data.run.status,
    runType: data.run.runType,
    progressPercent: data.run.progressPercent,
    stage: data.run.stage,
    duration: end - start,
    assignmentCount: data.assignments.length,
    completedAssignmentCount: data.assignments.filter(a => a.status === "completed").length,
    failedAssignmentCount: data.assignments.filter(a => a.status === "failed").length,
    verificationCount: data.verifications.length,
    passedVerificationCount: data.verifications.filter(v => v.status === "passed").length,
    failedVerificationCount: data.verifications.filter(v => v.status === "failed").length,
    startedAt: data.run.startedAt,
    completedAt: data.run.completedAt,
    errorMessage: data.run.errorMessage,
  };
}
