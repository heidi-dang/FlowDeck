import { UIProps } from './types';
import { escapeHTML } from './utils';

export const AgentActivityGrid = ({ state }: UIProps) => {
  const agents = Object.values(state.agentActivities || {});
  return `
    <div class="agent-activity-grid" role="region" aria-label="Agent Activities">
      ${agents.map(a => `
        <div class="agent-card" tabindex="0">
          <h4>${escapeHTML(a.agentId)}</h4>
          <p>Responsibility: ${escapeHTML(a.responsibility)}</p>
          <p>Current Op: ${escapeHTML(a.currentOperation)}</p>
          <p>Status: ${escapeHTML(a.status)}</p>
          <p>Duration: ${a.durationMs}ms</p>
          <p>Tokens: ${a.tokenUsage}</p>
          <p>Tools: ${a.toolsUsed}</p>
          ${a.result ? `<p>Result: ${escapeHTML(a.result)}</p>` : ''}
        </div>
      `).join('')}
    </div>
  `;
};