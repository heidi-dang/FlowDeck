import { ConnectionState } from './connection-state';
import { SSEParser, SSEMessage } from './sse-parser';
import { SequenceTracker } from './sequence-tracker';

export interface StreamClientOptions {
  url: string;
  headers?: Record<string, string>;
  abortSignal?: AbortSignal;
  onStateChange?: (state: ConnectionState) => void;
  onEvent?: (event: SSEMessage) => void;
  onError?: (error: Error) => void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export class FlowDeckStreamClient {
  private options: StreamClientOptions;
  private state: ConnectionState = 'idle';
  private parser: SSEParser;
  private tracker: SequenceTracker;
  private lastEventId?: string;
  private reconnectAttempts: number = 0;
  private internalAbortController?: AbortController;
  private userAbortHandler?: () => void;
  private isExplicitlyAborted = false;

  constructor(options: StreamClientOptions) {
    this.options = {
      reconnectBaseMs: 1000,
      reconnectMaxMs: 30000,
      ...options
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
      ...this.options.headers
    };

    if (this.lastEventId) {
      headers['Last-Event-ID'] = this.lastEventId;
    }

    try {
      const response = await fetch(this.options.url, {
        headers,
        signal: this.internalAbortController.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP error ${response.status}`);
      }
      
      this.reconnectAttempts = 0;
      this.setState('live');

      if (!response.body) {
        throw new Error("No response body");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        this.parser.parseChunk(chunk, (msg) => this.handleMessage(msg));
      }
      
      this.setState('completed');
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

    if (msg.event === 'snapshot') {
      this.tracker.handleSnapshot();
    }

    const eventId = msg.id || `${Date.now()}-${Math.random()}`;
    const seqMatches = msg.data.match(/"seq":\s*(\d+)/);
    const seq = seqMatches ? parseInt(seqMatches[1], 10) : undefined;
    
    if (this.tracker.track(eventId, seq)) {
      this.options.onEvent?.(msg);
    }
  }

  private scheduleReconnect() {
    this.setState('reconnecting');
    const delay = Math.min(
      this.options.reconnectMaxMs!,
      this.options.reconnectBaseMs! * Math.pow(2, this.reconnectAttempts)
    );
    const jitter = delay * 0.1 * Math.random();
    const finalDelay = delay + jitter;
    
    this.reconnectAttempts++;
    
    setTimeout(() => {
      if (this.state === 'reconnecting') {
        this.connect();
      }
    }, finalDelay);
  }

  public abort() {
    this.isExplicitlyAborted = true;
    this.internalAbortController?.abort();
    if (this.userAbortHandler && this.options.abortSignal) {
      this.options.abortSignal.removeEventListener('abort', this.userAbortHandler);
    }
    this.setState('cancelled');
  }
}
