import { FlowDeckStreamEvent } from './stream-event';

// Hooks for deterministic testing and observability
export type SseSessionHook = {
  onBufferStart?: (sessionId: string) => void;
  onBrokerRegister?: (sessionId: string) => void;
  onWatermarkSet?: (sessionId: string, highWatermark: number) => void;
  onReplayComplete?: (sessionId: string) => void;
  onLiveTransition?: (sessionId: string) => void;
};

export class SseSession {
  private buffering = false;
  private highWatermark = 0;
  private buffer: FlowDeckStreamEvent[] = [];
  private hooks: SseSessionHook = {};

  constructor(private res: any, public clientId: string, hooks?: SseSessionHook) {
    if (hooks) this.hooks = hooks;
  }

  // Must be called before broker registration to avoid race
  startBuffering(highWatermark: number = 0) {
    this.buffering = true;
    this.highWatermark = highWatermark;
    this.buffer = [];
    this.hooks.onBufferStart?.(this.clientId);
  }

  setHighWatermark(highWatermark: number) {
    this.highWatermark = highWatermark;
    this.hooks.onWatermarkSet?.(this.clientId, highWatermark);
  }

  // Called by broker after client registration
  registerWithBroker() {
    this.hooks.onBrokerRegister?.(this.clientId);
  }

  enqueueOrSend(event: FlowDeckStreamEvent) {
    if (this.buffering) {
      this.buffer.push(event);
    } else {
      this.sendEvent(event);
    }
  }

  // Flush after replay completes; ensures ordering and deduplication
  flushBuffer() {
    this.buffering = false;
    // Sort by sequence
    this.buffer.sort((a, b) => a.sequence - b.sequence);
    // Deduplicate events with sequence <= highWatermark
    const unique = new Map<number, FlowDeckStreamEvent>();
    for (const evt of this.buffer) {
      if (evt.sequence > this.highWatermark && !unique.has(evt.sequence)) {
        unique.set(evt.sequence, evt);
      }
    }
    // Send in order
    for (const evt of unique.values()) {
      this.sendEvent(evt);
    }
    this.buffer = [];
    this.hooks.onReplayComplete?.(this.clientId);
    this.hooks.onLiveTransition?.(this.clientId);
  }

  sendEvent(event: FlowDeckStreamEvent) {
    const data = JSON.stringify(event);
    const message = `id: ${event.sequence}\nevent: ${event.type}\ndata: ${data}\n\n`;
    try {
      this.res.write(message);
    } catch {
      // client disconnected silently
    }
  }

  sendHeartbeat(timestamp: number) {
    try {
      this.res.write(`: heartbeat ${timestamp}\n\n`);
    } catch {
      // client disconnected silently
    }
  }

  close() {
    try {
      this.res.end();
    } catch {
      // client disconnected silently
    }
  }
}
