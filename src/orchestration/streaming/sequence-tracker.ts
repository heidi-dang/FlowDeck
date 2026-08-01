export class SequenceTracker {
  private seenIds: Set<string> = new Set();
  private maxSeenSize: number;
  private orderedSeenIds: string[] = [];
  private lastSequenceNumber: number = -1;

  constructor(maxSeenSize: number = 1000) {
    this.maxSeenSize = maxSeenSize;
  }

  public track(eventId: string, sequenceNumber?: number): boolean {
    if (this.seenIds.has(eventId)) {
      return false; // Duplicate
    }

    if (sequenceNumber !== undefined) {
       this.lastSequenceNumber = sequenceNumber;
    }

    this.seenIds.add(eventId);
    this.orderedSeenIds.push(eventId);
    
    if (this.orderedSeenIds.length > this.maxSeenSize) {
      const removedId = this.orderedSeenIds.shift();
      if (removedId) {
        this.seenIds.delete(removedId);
      }
    }

    return true; // Not duplicate
  }

  public handleSnapshot() {
    this.seenIds.clear();
    this.orderedSeenIds = [];
    this.lastSequenceNumber = -1;
  }
}
