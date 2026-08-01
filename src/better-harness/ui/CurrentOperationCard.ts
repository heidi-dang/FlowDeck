import { UIProps } from './types';
    export const CurrentOperationCard = ({ state }: UIProps) => {
      return `
        <div class="current-operation-card" style="position: sticky; top: 0;" aria-live="assertive" role="status">
          <h2>Current Operation</h2>
          <p>${state.currentOperation || 'Waiting for operation...'}</p>
        </div>
      `;
    };