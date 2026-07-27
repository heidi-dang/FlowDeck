export type HarnessEventType =
  | "run.queued"
  | "run.started"
  | "collector.started"
  | "collector.completed"
  | "analysis.started"
  | "finding.created"
  | "run.progress"
  | "report.completed"
  | "run.cancelled"
  | "run.failed";

export interface HarnessEvent {
  type: HarnessEventType;
  timestamp: string;
  data?: Record<string, unknown>;
}

export type EventHandler = (event: HarnessEvent) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  subscribe(type: HarnessEventType, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => {
      this.handlers.get(type)?.delete(handler);
    };
  }

  emit(type: HarnessEventType, data?: Record<string, unknown>): void {
    const event: HarnessEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    const handlers = this.handlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          void Promise.resolve(handler(event));
        } catch { /* handler error */ }
      }
    }
  }
}
