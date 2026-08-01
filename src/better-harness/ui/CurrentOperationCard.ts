import { UIProps } from './types';
import { escapeHTML } from './utils';

export const CurrentOperationCard = ({ state }: UIProps) => {
  const op = state.currentOperation ? escapeHTML(state.currentOperation) : 'Idle';
  return `
    <div class="current-operation-card sticky-card" aria-live="assertive" aria-label="Current Operation">
      <h2>Primary Operation</h2>
      <p class="operation-text">${op}</p>
    </div>
  `;
};