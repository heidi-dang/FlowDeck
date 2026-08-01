import { UIProps } from './types';

export const EvidenceDrawer = ({ state }: UIProps) => {
  return `<div class="evidence-drawer" aria-label="Evidence Drawer">Evidence Items: ${Object.keys(state.verificationChecks || {}).length}</div>`;
};