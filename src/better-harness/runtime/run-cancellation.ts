const cancelledRuns = new Set<string>();

export function cancelRun(runId: string): boolean {
  if (cancelledRuns.has(runId)) return false; // already cancelled
  cancelledRuns.add(runId);
  return true;
}

export function isRunCancelled(runId: string): boolean {
  return cancelledRuns.has(runId);
}

export function clearCancellation(runId: string): void {
  cancelledRuns.delete(runId);
}
