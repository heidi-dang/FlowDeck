import { OrchestrationEvent } from "../types/events";
import { IEventBus, EventHandler } from "./ports";

export class InMemoryEventBus implements IEventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private readonly allHandlers = new Set<EventHandler>();

  async publish(event: OrchestrationEvent): Promise<void> {
    // Specific type handlers
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        await Promise.resolve(handler(event));
      }
    }

    // Catch-all handlers
    for (const handler of this.allHandlers) {
      await Promise.resolve(handler(event));
    }
  }

  subscribe(type: string, handler: EventHandler): () => void {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, new Set());
    }
    this.handlers.get(type)!.add(handler);
    return () => { this.handlers.get(type)?.delete(handler); };
  }

  subscribeAll(handler: EventHandler): () => void {
    this.allHandlers.add(handler);
    return () => { this.allHandlers.delete(handler); };
  }

  getSubscriberCount(): number {
    let count = this.allHandlers.size;
    for (const [, handlers] of this.handlers) {
      count += handlers.size;
    }
    return count;
  }
}
