import { UIProps } from './types';
    export const StageRail = ({ state }: UIProps) => {
      const stages = ['intake', 'context', 'plan', 'execute', 'verify', 'complete'];
      return `
        <nav class="stage-rail" aria-label="Run Stages" style="overflow-x: auto; display: flex; gap: 8px;">
          ${stages.map(stage => {
            const status = state.stageStates[stage as keyof typeof state.stageStates];
            return `
              <div class="stage-badge stage-${status}" tabindex="0" role="group" aria-label="Stage ${stage} is ${status}">
                ${stage}
              </div>
            `;
          }).join('')}
        </nav>
      `;
    };