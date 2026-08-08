import { SseSession } from './sse-session';
import { FlowDeckStreamEvent } from './stream-event';

export class BackpressureController {
  private buffer: FlowDeckStreamEvent[] = [];
  private MAX_BUFFER_SIZE = 100;

  constructor(private session: SseSession, maxBufferSize?: number) {
    if (maxBufferSize) {
      this.MAX_BUFFER_SIZE = maxBufferSize;
    }
  }

  enqueue(event: FlowDeckStreamEvent): boolean {
    if (this.buffer.length >= this.MAX_BUFFER_SIZE) {
      const dropIndex = this.buffer.findIndex(
        (e) => e.type === 'model.first_token' || e.type === 'agent.progress' || e.type === 'metrics.updated',
      );
      if (dropIndex !== -1) {
        this.buffer.splice(dropIndex, 1);
      } else if (event.importance === 'important' || event.importance === 'critical') {
        this.buffer.shift();
      } else {
        return false;
      }
    }
    this.buffer.push(event);
    this.flush();
    return true;
  }

  isCongested(): boolean {
    return this.buffer.length >= this.MAX_BUFFER_SIZE;
  }

  flush() {
    while (this.buffer.length > 0) {
      const event = this.buffer.shift();
      if (event) {
        this.session.sendEvent(event);
      }
    }
  }
}
