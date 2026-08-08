import { UIProps } from './types';

export const RunMetricsBar = ({ state }: UIProps) => {
  return `<div class="run-metrics-bar" aria-label="Run Metrics Bar">Time: ${state.metrics.elapsedMs || 0}ms</div>`;
};