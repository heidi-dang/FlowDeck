import { UIProps } from './types';

export const ReconnectBanner = ({ state }: UIProps) => {
  return state.connectionState === 'reconnecting'
    ? `<div class="reconnect-banner" aria-live="assertive">Reconnecting stream...</div>`
    : '';
};