import { FlowDeckStreamEvent } from './stream-event';

export class SseSession {
  private buffering = false;
  private highWatermark = 0;
  private buffer: FlowDeckStreamEvent[] = [];

  constructor(private res: any, public clientId: string) {}

  startBuffering(highWatermark: number) {
    this.buffering = true;
    this.highWatermark = highWatermark;
    this.buffer = [];
  }

  enqueueOrSend(event: FlowDeckStreamEvent) {
    if (this.buffering) {
      if (event.sequence > this.highWatermark) {
        this.buffer.push(event);
      }
    } else {
      this.sendEvent(event);
    }
  }

  flushBuffer() {
    this.buffering = false;
    // Sort buffered events by sequence before flushing
    this.buffer.sort((a, b) => a.sequence - b.sequence);

    // Deduplicate any buffered events <= highWatermark
    const uniqueEvents = new Map<number, FlowDeckStreamEvent>();
    for (const evt of this.buffer) {
      if (evt.sequence > this.highWatermark && !uniqueEvents.has(evt.sequence)) {
        uniqueEvents.set(evt.sequence, evt);
      }
    }

    for (const evt of uniqueEvents.values()) {
      this.sendEvent(evt);
    }
    this.buffer = [];
  }

  sendEvent(event: FlowDeckStreamEvent) {
    // Send full canonical FlowDeckStreamEvent in data: payload
    const data = JSON.stringify(event);
    const message = `id: ${event.sequence}\nevent: ${event.type}\ndata: ${data}\n\n`;
    try {
      this.res.write(message);
    } catch {
      /* client disconnected */
    }
  }

  sendHeartbeat(timestamp: number) {
    try {
      this.res.write(`: heartbeat ${timestamp}\n\n`);
    } catch {
      /* client disconnected */
    }
  }

  close() {
    try {
      this.res.end();
    } catch {
      /* client disconnected */
    }
  }
}
