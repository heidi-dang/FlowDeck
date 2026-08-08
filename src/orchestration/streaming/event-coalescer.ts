import { FlowDeckStreamEvent } from './stream-event';

export class EventCoalescer {
  coalesce(events: FlowDeckStreamEvent[]): FlowDeckStreamEvent[] {
    const result: FlowDeckStreamEvent[] = [];
    const tokenUpdates = new Map<string, FlowDeckStreamEvent>();
    const metricsUpdates = new Map<string, FlowDeckStreamEvent>();

    for (const event of events) {
      if (event.type === 'model.first_token' || event.type === 'agent.progress') {
        tokenUpdates.set(event.runId, event);
      } else if (event.type === 'metrics.updated') {
        metricsUpdates.set(event.runId, event);
      } else {
        result.push(event); // pass through immediately
      }
    }

    result.push(...Array.from(tokenUpdates.values()));
    result.push(...Array.from(metricsUpdates.values()));
    
    return result.sort((a, b) => a.sequence - b.sequence);
  }
}
