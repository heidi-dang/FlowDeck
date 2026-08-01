import { UIProps } from './types';

export const DecisionTimeline = ({ state }: UIProps) => {
  return `<div class="decision-timeline" aria-label="Decision Timeline">Decisions: ${state.lastSequence >= 0 ? state.lastSequence + 1 : 0} events</div>`;
};