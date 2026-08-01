import { SseSession } from './sse-session';

export class HeartbeatService {
  private timers = new Map<string, NodeJS.Timeout>();

  start(session: SseSession) {
    const timer = setInterval(() => {
      session.sendHeartbeat(Date.now());
    }, 15000); // 15 seconds
    this.timers.set(session.clientId, timer);
  }

  stop(clientId: string) {
    const timer = this.timers.get(clientId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(clientId);
    }
  }
}
