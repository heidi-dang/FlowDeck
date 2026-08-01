import { StreamRepository } from './stream-repository';
import { SseSession } from './sse-session';
import { FlowDeckStreamEvent, createStreamEvent } from './stream-event';

export class StreamReplayService {
  constructor(private repo: StreamRepository) {}

  async replayToSession(runId: string, afterSequence: number, session: SseSession) {
    const events = this.repo.getEventsAfter(runId, afterSequence);
    for (const row of events) {
      const event: FlowDeckStreamEvent = createStreamEvent({
        eventId: String(row.sequence),
        sequence: row.sequence,
        runId: row.run_id,
        type: row.type as any,
        stage: "execute",
        importance: "normal",
        title: row.type,
        payload: row.data,
      });
      session.sendEvent(event);
    }
  }
}

