import { UIProps } from './types';
import { escapeHTML } from './utils';

export const CompletionSummary = ({ state }: UIProps) => {
  const summary = state.terminalState ? `Run Completed (${escapeHTML(state.terminalState)})` : 'Run In Progress';
  return `<div class="completion-summary" aria-label="Completion Summary">${summary}</div>`;
};