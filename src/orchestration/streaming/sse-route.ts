import { SseBroker } from './sse-broker';
import { SseSession } from './sse-session';
import { StreamReplayService } from './replay-service';
import { StreamRepository } from './stream-repository';

export function createSseRoute(broker: SseBroker, replayService: StreamReplayService, repository: StreamRepository) {
  return async (req: any, res: any) => {
    const runId = req.params?.runId || req.url?.match(/\/api\/runs\/([^/]+)\/events/)?.[1] || req.url?.match(/runs\/([^/]+)\/events/)?.[1];

    if (!runId) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Missing runId' }));
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

    const lastEventIdHeader = req.headers['last-event-id'] || req.query?.after;
    const initialSequence = (lastEventIdHeader !== undefined && lastEventIdHeader !== null && lastEventIdHeader !== '')
      ? parseInt(String(lastEventIdHeader), 10)
      : 0;

    const startSeq = isNaN(initialSequence) ? 0 : initialSequence;

    // High-watermark provably correct atomic handoff:
    // 1. Establish committed high watermark H from DB
    const highWatermark = repository ? repository.getHighWatermark(runId) : 0;

    if (highWatermark > startSeq) {
      // 2. Begin client buffering for live events > H
      session.startBuffering(highWatermark);

      // 3. Register live subscription with broker
      broker.addClient(runId, session);

      // 4. Replay committed events (startSeq, highWatermark]
      await replayService.replayToSession(runId, startSeq, highWatermark, session);

      // 5. Sort, deduplicate, and flush buffered live events > H in sequence order
      session.flushBuffer();
    } else {
      broker.addClient(runId, session);
    }

    req.on('close', () => {
      broker.removeClient(runId, clientId);
    });
  };
}
