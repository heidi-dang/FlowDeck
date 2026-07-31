export interface AssignmentSummaryProjection {
  assignmentId: string;
  runId: string;
  agentId: string;
  role: string;
  status: string;
  duration: number | null;
  taskDescription?: string;
  outputSummary?: string;
  verifications: Array<{ id: string; status: string; checkType: string; result: string }>;
  createdAt: string;
  completedAt?: string;
}

export function buildAssignmentSummaryProjection(data: {
  assignment: { id: string; runId: string; agentId: string; role: string; status: string; taskDescription?: string; outputSummary?: string; createdAt: string; completedAt?: string };
  verifications: Array<{ id: string; status: string; checkType: string; result: string }>;
}): AssignmentSummaryProjection {
  const start = new Date(data.assignment.createdAt).getTime();
  const end = data.assignment.completedAt ? new Date(data.assignment.completedAt).getTime() : Date.now();
  return {
    assignmentId: data.assignment.id,
    runId: data.assignment.runId,
    agentId: data.assignment.agentId,
    role: data.assignment.role,
    status: data.assignment.status,
    duration: end - start,
    taskDescription: data.assignment.taskDescription,
    outputSummary: data.assignment.outputSummary,
    verifications: data.verifications,
    createdAt: data.assignment.createdAt,
    completedAt: data.assignment.completedAt,
  };
}
