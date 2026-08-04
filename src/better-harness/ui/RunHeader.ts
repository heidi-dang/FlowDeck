import { UIProps } from './types';
import { escapeHTML } from './utils';

export const RunHeader = ({ state, onCancel }: UIProps) => {
  const tokenUsage = (state.metrics.inputTokens || 0) + (state.metrics.outputTokens || 0);
  const cost = state.metrics.estimatedCostUsd || 0;
  const title = escapeHTML(state.title || 'Unknown Run');
  const stage = escapeHTML(state.currentStage || 'Pending');
  const connState = escapeHTML(state.connectionState);
  const termState = state.terminalState ? escapeHTML(state.terminalState) : 'Running';

  return `
    <header class="run-header" role="banner">
      <h1 aria-live="polite">${title} - ${stage}</h1>
      <div class="metrics">
        <span>Time: ${state.metrics.elapsedMs || 0}ms</span>
        <span>Tokens: ${tokenUsage}</span>
        <span>Cost: $${cost.toFixed(4)}</span>
      </div>
      <div class="connection-status" aria-live="polite">Status: ${connState}</div>
      <div class="terminal-status" aria-live="polite">Terminal: ${termState}</div>
      ${!state.terminalState && onCancel ? `<button data-action="cancel-run" aria-label="Cancel Run">Cancel</button>` : ''}
    </header>
  `;
};