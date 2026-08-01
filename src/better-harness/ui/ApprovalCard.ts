import { UIProps } from './types';

export const ApprovalCard = ({ state }: UIProps) => {
  return `<div class="approval-card" aria-label="Approval Status">${state.terminalState === 'cancelled' ? 'Approval Revoked' : 'No Action Required'}</div>`;
};