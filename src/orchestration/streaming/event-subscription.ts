import type { OrchestrationEvent, EventSubscriber } from "../types";

export class EventSubscriptionManager {
  private readonly subscribers = new Map<string, EventSubscriber>();
  private deliveryCount = 0;
  private failureCount = 0;

  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.set(subscriber.id, subscriber);
    return () => {
      this.subscribers.delete(subscriber.id);
    };
  }

  unsubscribe(id: string): void {
    this.subscribers.delete(id);
  }

  async deliver(event: OrchestrationEvent): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [, subscriber] of this.subscribers) {
      // Apply subscriber filter
      if (subscriber.filter?.types && !subscriber.filter.types.includes(event.type as any)) continue;
      if (subscriber.filter?.runId && event.runId !== subscriber.filter.runId) continue;

      const promise = (async () => {
        try {
          await subscriber.handler(event);
          this.deliveryCount++;
        } catch (error) {
          this.failureCount++;
          subscriber.onError?.(error instanceof Error ? error : new Error(String(error)), event);
        }
      })();
      promises.push(promise);
    }

    await Promise.all(promises);
  }

  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  getDeliveryStats(): { delivered: number; failed: number; subscribers: number } {
    return {
      delivered: this.deliveryCount,
      failed: this.failureCount,
      subscribers: this.subscribers.size,
    };
  }
}
