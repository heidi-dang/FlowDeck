import { UIProps } from './types';
    export const VerificationPanel = ({ state }: UIProps) => {
      const checks = Object.values(state.verificationChecks);
      return `
        <div class="verification-panel" role="region" aria-label="Verification Status">
          ${checks.map(c => `
            <div class="check-card check-${c.status}" tabindex="0">
              <h4>${c.name}</h4>
              <p>Status: ${c.status}</p>
              ${c.details ? `<p>${c.details}</p>` : ''}
            </div>
          `).join('')}
        </div>
      `;
    };