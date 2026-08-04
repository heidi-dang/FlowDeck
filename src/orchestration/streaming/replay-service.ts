import { StreamRepository } from './stream-repository';
import { SseSession } from './sse-session';
import { FlowDeckStreamEvent } from './stream-event';

export class StreamReplayService {
  constructor(private repo: StreamRepository) {}

  async replayToSession(
    runId: string,
    afterExclusive: number,
    throughInclusiveOrSession: number | SseSession,
    session?: SseSession
  ) {
    if (typeof throughInclusiveOrSession === 'object' && throughInclusiveOrSession !== null) {
      const targetSession = throughInclusiveOrSession as SseSession;
      const events: FlowDeckStreamEvent[] = this.repo.getEventsAfter(runId, afterExclusive);
      for (const event of events) {
        targetSession.sendEvent(event);
      }
    } else {
      const throughInclusive = throughInclusiveOrSession as number;
      const targetSession = session!;
      const events: FlowDeckStreamEvent[] = this.repo.getEventsInRange(runId, afterExclusive, throughInclusive);
      for (const event of events) {
        targetSession.sendEvent(event);
      }
    }
  }

  async replayAllAfter(runId: string, afterSequence: number, session: SseSession) {
    const events: FlowDeckStreamEvent[] = this.repo.getEventsAfter(runId, afterSequence);
    for (const event of events) {
      session.sendEvent(event);
    }
  }
}
