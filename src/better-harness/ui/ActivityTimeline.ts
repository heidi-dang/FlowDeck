import { UIProps } from './types';

export const ActivityTimeline = ({ state }: UIProps) => {
  const opCount = Object.keys(state.toolExecutions || {}).length;
  return `
    <div class="activity-timeline" aria-label="Activity Timeline">
      <h3>Activity Timeline (${opCount} operations)</h3>
      <div class="timeline-entries">
        ${Object.values(state.toolExecutions || {})
          .map((t) => `<div class="timeline-item" tabindex="0">${t.toolName}: ${t.status}</div>`)
          .join('')}
      </div>
    </div>
  `;
};