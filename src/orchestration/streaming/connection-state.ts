export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'recovering'
  | 'replaying'
  | 'snapshot_required'
  | 'degraded'
  | 'reconnecting'
  | 'completed'
  | 'cancelled'
  | 'failed';
