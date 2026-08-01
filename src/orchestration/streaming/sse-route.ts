import { SseBroker } from './sse-broker';
import { SseSession } from './sse-session';
import { StreamReplayService } from './replay-service';
import { StreamRepository } from './stream-repository';

export function createSseRoute(broker: SseBroker, replayService: StreamReplayService, repository?: StreamRepository) {
  return async (req: any, res: any) => {
    const runId = req.params?.runId || req.url?.match(/\/api\/runs\/([^/]+)\/events/)?.[1] || req.url?.match(/runs\/([^/]+)\/events/)?.[1];

    if (!runId) {
      res.statusCode = 400;
      res.end('Missing runId');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.write(': connected\n\n');

    const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const session = new SseSession(res, clientId);

    const lastEventId = req.headers['last-event-id'] || req.query?.after;

    if (lastEventId) {
      const sequence = parseInt(lastEventId as string, 10);
      if (!isNaN(sequence)) {
        // High-watermark atomic handoff:
        // 1. Get current highest sequence in database before subscribing
        const events = repository ? repository.getEventsAfter(runId, 0) : [];
        const highWatermark = events.length > 0 ? Math.max(...events.map(e => e.sequence)) : sequence;

        // 2. Start buffering live events > highWatermark
        session.startBuffering(highWatermark);

        // 3. Register client to broker to receive live broadcasts into buffer
        broker.addClient(runId, session);

        // 4. Replay historical events (sequence, highWatermark]
        await replayService.replayToSession(runId, sequence, session);

        // 5. Flush buffered live events > highWatermark and transition to live mode
        session.flushBuffer();
      } else {
        broker.addClient(runId, session);
      }
    } else {
      broker.addClient(runId, session);
    }

    req.on('close', () => {
      broker.removeClient(runId, clientId);
    });
  };
}
