export class SequenceValidator {
  private lastSequences = new Map<string, number>();

  validate(runId: string, sequence: number): { valid: boolean; error?: string } {
    const lastSeq = this.lastSequences.get(runId) || 0;
    
    if (sequence <= lastSeq) {
      return { valid: false, error: `Duplicate sequence ${sequence} for run ${runId}` };
    }
    
    if (sequence > lastSeq + 1) {
      return { valid: false, error: `Gap detected for run ${runId}: expected ${lastSeq + 1}, got ${sequence}` };
    }
    
    this.lastSequences.set(runId, sequence);
    return { valid: true };
  }

  setLastSequence(runId: string, sequence: number) {
    this.lastSequences.set(runId, sequence);
  }

  getLastSequence(runId: string): number {
    return this.lastSequences.get(runId) || 0;
  }
}
