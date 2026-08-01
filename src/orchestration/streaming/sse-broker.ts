import { SseSession } from './sse-session';
import { FlowDeckStreamEvent } from './stream-event';
import { BackpressureController } from './backpressure-controller';

export class SseBroker {
  private clients = new Map<string, Set<SseSession>>();
  private backpressureControllers = new Map<string, BackpressureController>();

  addClient(runId: string, session: SseSession) {
    if (!this.clients.has(runId)) {
      this.clients.set(runId, new Set());
    }
    this.clients.get(runId)!.add(session);
    this.backpressureControllers.set(session.clientId, new BackpressureController(session));
  }

  removeClient(runId: string, clientId: string) {
    const runClients = this.clients.get(runId);
    if (runClients) {
      for (const session of runClients) {
        if (session.clientId === clientId) {
          runClients.delete(session);
          break;
        }
      }
    }
    this.backpressureControllers.delete(clientId);
  }

  broadcast(runId: string, event: FlowDeckStreamEvent) {
    const runClients = this.clients.get(runId);
    if (runClients) {
      for (const session of runClients) {
        session.enqueueOrSend(event);
      }
    }
  }

  hasClients(runId: string): boolean {
    return this.clients.has(runId) && this.clients.get(runId)!.size > 0;
  }
}
