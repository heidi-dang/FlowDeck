import { ConnectionState } from './connection-state';
import { SSEParser, SSEMessage } from './sse-parser';
import { SequenceTracker } from './sequence-tracker';
import type { FlowDeckStreamEvent } from './stream-event';
import { validateStreamEvent } from './stream-event-schema';

export interface StreamClientOptions {
  url: string;
  headers?: Record<string, string>;
  abortSignal?: AbortSignal;
  onStateChange?: (state: ConnectionState) => void;
  onEvent?: (event: FlowDeckStreamEvent) => void;
  onRawMessage?: (msg: SSEMessage) => void;
  onError?: (error: Error) => void;
  onGapDetected?: (expected: number, received: number) => void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export class FlowDeckStreamClient {
  private options: StreamClientOptions;
  private state: ConnectionState = 'idle';
  private parser: SSEParser;
  private tracker: SequenceTracker;
  private lastEventId?: string;
  private lastCommittedSequence = 0;
  private reconnectAttempts: number = 0;
  private reconnectTimer?: any;
  private internalAbortController?: AbortController;
  private userAbortHandler?: () => void;
  private isExplicitlyAborted = false;

  constructor(options: StreamClientOptions) {
    this.options = {
      reconnectBaseMs: 500,
      reconnectMaxMs: 10000,
      ...options,
    };
    this.parser = new SSEParser();
    this.tracker = new SequenceTracker();

    if (this.options.abortSignal) {
      this.userAbortHandler = () => this.abort();
      this.options.abortSignal.addEventListener('abort', this.userAbortHandler);
    }
  }

  private setState(newState: ConnectionState) {
    if (this.state !== newState) {
      this.state = newState;
      this.options.onStateChange?.(newState);
    }
  }

  public async start() {
    if (this.state !== 'idle' && this.state !== 'failed' && this.state !== 'completed' && this.state !== 'cancelled') {
      return;
    }
    this.isExplicitlyAborted = false;
    this.setState('connecting');
    await this.connect();
  }

  private async connect() {
    this.internalAbortController = new AbortController();

    const headers: Record<string, string> = {
      'Accept': 'text/event-stream',
      ...this.options.headers,
    };

    if (this.lastEventId) {
      headers['Last-Event-ID'] = this.lastEventId;
    }

    try {
      const response = await fetch(this.options.url, {
        headers,
        signal: this.internalAbortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }

      this.reconnectAttempts = 0;
      this.setState('live');

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        if (this.isExplicitlyAborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        this.parser.parseChunk(chunk, (msg) => this.handleMessage(msg));
      }

      if (!this.isExplicitlyAborted) {
        this.setState('completed');
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || this.isExplicitlyAborted) {
        this.setState('cancelled');
        return;
      }

      this.options.onError?.(err);
      this.scheduleReconnect();
    }
  }

  private handleMessage(msg: SSEMessage) {
    if (msg.id) {
      this.lastEventId = msg.id;
    }

    this.options.onRawMessage?.(msg);

    if (msg.event === 'snapshot') {
      this.tracker.handleSnapshot();
      try {
        const snap = JSON.parse(msg.data);
        if (snap && typeof snap.sequence === 'number') {
          this.lastCommittedSequence = snap.sequence;
        }
      } catch { /* ignore */ }
      this.setState('snapshot_required');
      this.setState('live');
      return;
    }

    let parsedData: any = null;
    try {
      parsedData = JSON.parse(msg.data);
    } catch {
      return;
    }

    // Validate canonical schema version and envelope
    if (!parsedData || typeof parsedData !== 'object') return;
    if (parsedData.schemaVersion !== 1 && parsedData.schemaVersion !== undefined) return;

    const validation = validateStreamEvent(parsedData);
    if (!validation.success || !validation.data) {
      return;
    }

    const event: FlowDeckStreamEvent = validation.data;

    // Sequence & Gap checking
    if (this.lastCommittedSequence > 0 && event.sequence <= this.lastCommittedSequence) {
      // Duplicate or regression sequence — ignore
      return;
    }

    if (this.lastCommittedSequence > 0 && event.sequence > this.lastCommittedSequence + 1) {
      // Sequence gap detected: pause direct projection, transition to recovering
      this.setState('recovering');
      this.options.onGapDetected?.(this.lastCommittedSequence + 1, event.sequence);
      // Initiate replay recovery from lastCommittedSequence
      this.lastEventId = String(this.lastCommittedSequence);
      this.scheduleReconnect();
      return;
    }

    const eventId = event.eventId || msg.id || `${Date.now()}`;
    if (this.tracker.track(eventId, event.sequence)) {
      this.lastCommittedSequence = event.sequence;
      if (this.state === 'recovering' || this.state === 'reconnecting') {
        this.setState('replaying');
      }
      this.options.onEvent?.(event);
      if (this.state === 'replaying') {
        this.setState('live');
      }

      // Terminal event completion check
      if (event.type === 'run.completed' || event.type === 'run.failed' || event.type === 'run.cancelled') {
        this.setState(event.type === 'run.completed' ? 'completed' : (event.type === 'run.cancelled' ? 'cancelled' : 'failed'));
      }
    }
  }

  private scheduleReconnect() {
    if (this.isExplicitlyAborted) return;
    this.setState('reconnecting');

    const delay = Math.min(
      this.options.reconnectMaxMs!,
      this.options.reconnectBaseMs! * Math.pow(2, this.reconnectAttempts)
    );
    const jitter = delay * 0.1 * Math.random();
    const finalDelay = delay + jitter;

    this.reconnectAttempts++;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(() => {
      if (this.state === 'reconnecting' && !this.isExplicitlyAborted) {
        this.connect();
      }
    }, finalDelay);
  }

  public abort() {
    this.isExplicitlyAborted = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.internalAbortController?.abort();
    if (this.userAbortHandler && this.options.abortSignal) {
      this.options.abortSignal.removeEventListener('abort', this.userAbortHandler);
    }
    this.setState('cancelled');
  }

  public getState(): ConnectionState {
    return this.state;
  }
}
