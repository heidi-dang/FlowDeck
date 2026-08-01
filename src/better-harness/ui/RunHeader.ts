import { UIProps } from './types';

export const RunHeader = ({ state, onCancel }: UIProps) => {
  const tokenUsage = (state.metrics.inputTokens || 0) + (state.metrics.outputTokens || 0);
  const cost = state.metrics.estimatedCostUsd || 0;
  return `
    <header class="run-header" role="banner">
      <h1 aria-live="polite">${state.title || 'Unknown Run'} - ${state.currentStage || 'Pending'}</h1>
      <div class="metrics">
        <span>Time: ${state.metrics.elapsedMs || 0}ms</span>
        <span>Tokens: ${tokenUsage}</span>
        <span>Cost: $${cost.toFixed(4)}</span>
      </div>
      <div class="connection-status" aria-live="polite">Status: ${state.connectionState}</div>
      <div class="terminal-status" aria-live="polite">${state.terminalState ? `Terminal: ${state.terminalState}` : 'Running'}</div>
      ${!state.terminalState && onCancel ? `<button onclick="${onCancel}" aria-label="Cancel Run">Cancel</button>` : ''}
    </header>
  `;
};