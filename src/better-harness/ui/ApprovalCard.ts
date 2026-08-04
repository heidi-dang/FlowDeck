import { UIProps } from './types';
import { escapeHTML } from './utils';

export const ApprovalCard = ({ state }: UIProps) => {
  const label = state.terminalState === 'cancelled' ? 'Approval Revoked' : 'No Action Required';
  return `<div class="approval-card" aria-label="Approval Status">${escapeHTML(label)}</div>`;
};