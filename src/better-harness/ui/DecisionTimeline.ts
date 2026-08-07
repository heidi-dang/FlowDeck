import { UIProps } from './types';
import { escapeHTML } from './utils';

export const DecisionTimeline = ({ state }: UIProps) => {
  return `<div class="decision-timeline" aria-label="Decision Timeline">Stage: ${escapeHTML(state.currentStage || 'Pending')}</div>`;
};