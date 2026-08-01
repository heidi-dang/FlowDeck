import { UIProps } from './types';
import { escapeHTML } from './utils';

export const ConnectionHealthIndicator = ({ state }: UIProps) => {
  return `<div class="connection-health" aria-label="Connection Health">${escapeHTML(state.connectionState)}</div>`;
};