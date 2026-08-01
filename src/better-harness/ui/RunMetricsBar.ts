import { UIProps } from './types';

export const RunMetricsBar = ({ state }: UIProps) => {
  return `
    <div class="run-metrics-bar" aria-label="Run Metrics">
      <span>Duration: ${state.metrics.elapsedMs}ms</span>
      <span>Inputs: ${state.metrics.inputTokens}</span>
      <span>Outputs: ${state.metrics.outputTokens}</span>
      <span>Tools: ${state.metrics.toolCalls}</span>
    </div>
  `;
};