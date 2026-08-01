import { SseBroker } from './sse-broker';
import { SseSession } from './sse-session';
import { StreamReplayService } from './replay-service';
import { StreamRepository } from './stream-repository';

export interface SseRouteTestHooks {
  onBeforeRegistration?: (clientId: string) => void;
  onBeforeWatermark?: (clientId: string) => void;
  onBeforeReplay?: (clientId: string) => void;
  onBeforeFlush?: (clientId: string) => void;
  onAfterFlush?: (clientId: string) => void;
}

export function createSseRoute(
  broker: SseBroker,
  replayService: StreamReplayService,
  repository: StreamRepository,
  testHooks?: SseRouteTestHooks
) {
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

    // Provably safe high-watermark handoff sequence:
    // This order guarantees no duplicate or missed events.
    // Events committed before registration are fetched via watermark and replayed.
    // Events committed after registration enter the buffer.
    // The watermark is read AFTER registration, ensuring any event in the buffer
    // that was also replayed (seq <= highWatermark) will be deduplicated when flushed.
    // 1. Create session in buffering mode BEFORE broker registration
    session.startBuffering();
    testHooks?.onBeforeRegistration?.(clientId);

    // 2. Register session with broker so any concurrent live broadcasts enter buffer
    broker.addClient(runId, session);
    testHooks?.onBeforeWatermark?.(clientId);

    // 3. Obtain committed high watermark H from DB
    const highWatermark = repository ? repository.getHighWatermark(runId) : 0;
    session.setHighWatermark(highWatermark);
    testHooks?.onBeforeReplay?.(clientId);

    // 4. Replay committed events (startSeq, H]
    if (highWatermark > startSeq) {
      await replayService.replayToSession(runId, startSeq, highWatermark, session);
    }

    testHooks?.onBeforeFlush?.(clientId);

    // 5. Sort, deduplicate, and flush buffered live events > H in sequence order
    session.flushBuffer();
    testHooks?.onAfterFlush?.(clientId);

    req.on('close', () => {
      broker.removeClient(runId, clientId);
    });
  };
}
