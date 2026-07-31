export class FakeEventBus {
  public events: any[] = [];
  public subscribers: Record<string, ((event: any) => Promise<void>)[]> = {};
  
  async publish(topic: string, event: any): Promise<void> {
    this.events.push({ topic, event });
    const subs = this.subscribers[topic] || [];
    for (const sub of subs) {
      await sub(event);
    }
  }
  
  subscribe(topic: string, handler: (event: any) => Promise<void>): void {
    if (!this.subscribers[topic]) {
      this.subscribers[topic] = [];
    }
    this.subscribers[topic].push(handler);
  }
  
  clear(): void {
    this.events = [];
  }
}
