export class SnapshotService {
  generateSnapshot(runId: string): any {
    return {
      type: 'snapshot',
      runId,
      state: {
        status: 'running',
        metrics: {}
      }
    };
  }
}
