import { UIProps } from './types';
    export const ToolExecutionGroup = ({ state }: UIProps) => {
      const tools = Object.values(state.toolExecutions);
      return `
        <div class="tool-execution-group">
          ${tools.map(t => `
            <div class="tool-card" tabindex="0">
              <h4>${t.toolName}</h4>
              <p>Status: ${t.status}</p>
              ${t.output ? `<pre>${t.output}</pre>` : ''}
            </div>
          `).join('')}
        </div>
      `;
    };