export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'replaying'
  | 'degraded'
  | 'reconnecting'
  | 'completed'
  | 'cancelled'
  | 'failed';
