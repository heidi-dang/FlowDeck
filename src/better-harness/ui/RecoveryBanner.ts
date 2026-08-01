import { UIProps } from './types';

export const RecoveryBanner = ({ state }: UIProps) => {
  return state.errors.length > 0
    ? `<div class="recovery-banner" aria-live="assertive">Errors encountered: ${state.errors.join(', ')}</div>`
    : '';
};