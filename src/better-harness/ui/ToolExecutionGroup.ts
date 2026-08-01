import { UIProps } from './types';
import { escapeHTML } from './utils';

export const ToolExecutionGroup = ({ state }: UIProps) => {
  const tools = Object.values(state.toolExecutions || {});
  return `
    <div class="tool-execution-group" role="region" aria-label="Tool Executions">
      ${tools.map(t => `
        <div class="tool-card" tabindex="0">
          <h5>Tool: ${escapeHTML(t.toolName)} (${escapeHTML(t.status)})</h5>
          ${t.output ? `<pre class="tool-output">${escapeHTML(t.output)}</pre>` : ''}
        </div>
      `).join('')}
    </div>
  `;
};