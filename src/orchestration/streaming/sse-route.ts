import { SseBroker } from './sse-broker';
import { SseSession } from './sse-session';
import { StreamReplayService } from './replay-service';

export function createSseRoute(broker: SseBroker, replayService: StreamReplayService) {
  return async (req: any, res: any) => {
    const runId = req.params?.runId || req.url?.match(/\/api\/runs\/([^/]+)\/events/)?.[1];
    
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

    const clientId = Math.random().toString(36).substring(7);
    const session = new SseSession(res, clientId);

    const lastEventId = req.headers['last-event-id'] || req.query?.after;
    if (lastEventId) {
      const sequence = parseInt(lastEventId as string, 10);
      if (!isNaN(sequence)) {
        await replayService.replayToSession(runId, sequence, session);
      }
    }

    broker.addClient(runId, session);

    req.on('close', () => {
      broker.removeClient(runId, clientId);
    });
  };
}
