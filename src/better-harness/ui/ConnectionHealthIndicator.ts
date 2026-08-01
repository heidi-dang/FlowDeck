import { UIProps } from './types';

export const ConnectionHealthIndicator = ({ state }: UIProps) => {
  return `<div class="connection-health" aria-label="Connection Health">Status: ${state.connectionState}</div>`;
};