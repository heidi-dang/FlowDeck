import { FlowDeckStreamEvent } from './stream-event';

export class SseSession {
  constructor(private res: any, public clientId: string) {}

  sendEvent(event: FlowDeckStreamEvent) {
    const data = JSON.stringify(event.payload || (event as any).data || {});
    const message = `id: ${event.sequence}\nevent: ${event.type}\ndata: ${data}\n\n`;
    this.res.write(message);
  }

  sendHeartbeat(timestamp: number) {
    this.res.write(`: heartbeat ${timestamp}\n\n`);
  }

  close() {
    this.res.end();
  }
}
