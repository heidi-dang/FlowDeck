import { UIProps } from './types';
import { escapeHTML } from './utils';

export const VerificationPanel = ({ state }: UIProps) => {
  const checks = Object.values(state.verificationChecks || {});
  return `
    <div class="verification-panel" role="region" aria-label="Verification Checks">
      <h3>Verification Status</h3>
      <div class="checks-list">
        ${checks.map(c => `
          <div class="check-item" tabindex="0">
            <span>${escapeHTML(c.name)}:</span> <strong>${escapeHTML(c.status)}</strong>
            ${c.details ? ` - <em>${escapeHTML(c.details)}</em>` : ''}
          </div>
        `).join('')}
      </div>
    </div>
  `;
};