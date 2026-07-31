export interface EventTimelineProjection {
  runId: string;
  events: Array<{
    id: string;
    type: string;
    timestamp: string;
    data: Record<string, unknown>;
    correlationId: string;
  }>;
  total: number;
}

export function buildEventTimeline(runId: string, events: Array<{
  id: string; type: string; timestamp: string;
  data: Record<string, unknown>; correlationId: string;
}>): EventTimelineProjection {
  const sorted = [...events].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return { runId, events: sorted, total: sorted.length };
}
