import { UIProps } from './types';
import { escapeHTML } from './utils';

export const StageRail = ({ state }: UIProps) => {
  const stages = ['intake', 'context', 'plan', 'execute', 'verify', 'complete'];
  return `
    <nav class="stage-rail" aria-label="Run Stages" style="overflow-x: auto; display: flex; gap: 8px;">
      ${stages.map(stage => {
        const status = state.stageStates[stage as keyof typeof state.stageStates] || 'pending';
        return `
          <div class="stage-badge stage-${escapeHTML(status)}" tabindex="0" role="group" aria-label="Stage ${escapeHTML(stage)} is ${escapeHTML(status)}">
            ${escapeHTML(stage)}
          </div>
        `;
      }).join('')}
    </nav>
  `;
};