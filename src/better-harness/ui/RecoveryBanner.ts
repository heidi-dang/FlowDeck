import { UIProps } from './types';
import { escapeHTML } from './utils';

export const RecoveryBanner = ({ state }: UIProps) => {
  const rec = (state as any).recoveryState || (state as any).recovery;
  return `<div class="recovery-banner" aria-label="Recovery Banner">${rec ? escapeHTML(rec.status) : 'Healthy'}</div>`;
};