export class CancellationController {
  private cancelledRuns = new Set<string>();

  cancelRun(runId: string) {
    this.cancelledRuns.add(runId);
  }

  isCancelled(runId: string): boolean {
    return this.cancelledRuns.has(runId);
  }
}
