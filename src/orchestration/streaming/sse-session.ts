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
    for (const evt of this.buffer) {
      this.sendEvent(evt);
    }
    this.buffer = [];
  }

  sendEvent(event: FlowDeckStreamEvent) {
    const rawData = event.payload || (event as any).data || {};
    const data = typeof rawData === 'string' ? rawData : JSON.stringify(rawData);
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
