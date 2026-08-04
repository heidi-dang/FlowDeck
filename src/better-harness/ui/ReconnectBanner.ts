import { UIProps } from './types';
import { escapeHTML } from './utils';

export const ReconnectBanner = ({ state }: UIProps) => {
  return `<div class="reconnect-banner" aria-label="Reconnect Status">${escapeHTML(state.connectionState)}</div>`;
};