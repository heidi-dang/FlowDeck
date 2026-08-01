import { UIProps } from './types';
    export const AgentActivityGrid = ({ state }: UIProps) => {
      const agents = Object.values(state.agentActivities);
      return `
        <div class="agent-activity-grid" role="region" aria-label="Agent Activities">
          ${agents.map(a => `
            <div class="agent-card" tabindex="0">
              <h4>${a.agentId}</h4>
              <p>Responsibility: ${a.responsibility}</p>
              <p>Current Op: ${a.currentOperation}</p>
              <p>Status: ${a.status}</p>
              <p>Duration: ${a.durationMs}ms</p>
              <p>Tokens: ${a.tokenUsage}</p>
              <p>Tools: ${a.toolsUsed}</p>
              ${a.result ? `<p>Result: ${a.result}</p>` : ''}
            </div>
          `).join('')}
        </div>
      `;
    };