import { UIProps } from './types';

export const TechnicalEventDrawer = ({ state }: UIProps) => {
  return `<div class="technical-event-drawer" aria-label="Technical Event Details">Sequence: ${state.lastSequence}</div>`;
};