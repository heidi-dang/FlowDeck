import { UIProps } from './types';
import { escapeHTML } from './utils';

export const ActivityTimeline = ({ state }: UIProps) => {
  const executions = Object.values(state.toolExecutions || {});
  const opCount = executions.length;
  return `
    <div class="activity-timeline" aria-label="Activity Timeline">
      <h3>Activity Timeline (${opCount} operations)</h3>
      <div class="timeline-entries">
        ${executions
          .map((t) => `<div class="timeline-item" tabindex="0">${escapeHTML(t.toolName)}: ${escapeHTML(t.status)}</div>`)
          .join('')}
      </div>
    </div>
  `;
};