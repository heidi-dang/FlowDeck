import { UIProps } from './types';
    export const CompletionSummary = ({ state }: UIProps) => {
      if (state.terminalState) {
        return `<div class="completion-summary" role="alert" aria-live="assertive">Run finished with state: ${state.terminalState}</div>`;
      }
      return '';
    };