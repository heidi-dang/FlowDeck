import { UIProps } from './types';

export const EvidenceDrawer = ({ state }: UIProps) => {
  const count = ((state as any).evidence || state.errors || []).length;
  return `<div class="evidence-drawer" aria-label="Evidence Drawer">Evidence Items: ${count}</div>`;
};