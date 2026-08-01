/// <reference lib="dom" />

import { RunHeader } from './RunHeader';
import { StageRail } from './StageRail';
import { CurrentOperationCard } from './CurrentOperationCard';
import { ActivityTimeline } from './ActivityTimeline';
import { AgentActivityGrid } from './AgentActivityGrid';
import { ToolExecutionGroup } from './ToolExecutionGroup';
import { VerificationPanel } from './VerificationPanel';
import { EvidenceDrawer } from './EvidenceDrawer';
import { RunMetricsBar } from './RunMetricsBar';
import { ConnectionHealthIndicator } from './ConnectionHealthIndicator';
import { ReconnectBanner } from './ReconnectBanner';
import { CompletionSummary } from './CompletionSummary';
import { FlowDeckStreamClient } from '../../orchestration/streaming/browser-client';
import { reduceRunStreamEvent, INITIAL_STATE, RunProjectionState } from '../../orchestration/streaming/projection';
import type { FlowDeckStreamEvent } from '../../orchestration/streaming/stream-event';

export interface DashboardMountOptions {
  runId: string;
  url?: string;
  headers?: Record<string, string>;
  onCancelRun?: (runId: string) => void;
  featureFlagEnabled?: boolean;
}

export interface DashboardController {
  getState: () => RunProjectionState;
  applyEvent: (event: FlowDeckStreamEvent) => void;
  destroy: () => void;
}

export function mountLiveDashboard(
  container: HTMLElement,
  options: DashboardMountOptions
): DashboardController {
  let state: RunProjectionState = { ...INITIAL_STATE, runId: options.runId };
  const sseUrl = options.url || `/api/runs/${options.runId}/events`;

  container.innerHTML = '';
  container.className = 'flowdeck-live-dashboard';

  const render = () => {
    // Capture focused element identity, selection, and cursor position before DOM replacement
    const doc = typeof document !== 'undefined' ? document : null;
    const activeEl = doc?.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
    const activeId = activeEl?.id || null;
    const activeDataAction = activeEl?.getAttribute?.('data-action') || null;
    const activeRole = activeEl?.getAttribute?.('role') || null;

    // Do not restore focus if user is inside a dialog/modal/drawer that manages its own focus
    const isInsideDialog = activeEl?.closest?.('[role="dialog"], [role="alertdialog"], .evidence-drawer.open') !== null;

    let selectionStart: number | null = null;
    let selectionEnd: number | null = null;
    if (activeEl && ('selectionStart' in activeEl) && typeof activeEl.selectionStart === 'number') {
      selectionStart = activeEl.selectionStart;
      selectionEnd = activeEl.selectionEnd;
    }

    container.innerHTML = `
      ${ReconnectBanner({ state })}
      ${ConnectionHealthIndicator({ state })}
      ${RunHeader({ state, onCancel: options.onCancelRun ? () => options.onCancelRun!(options.runId) : undefined })}
      <main class="dashboard-shell" role="main">
        ${StageRail({ state })}
        ${CurrentOperationCard({ state })}
        <div class="dashboard-grid">
          ${AgentActivityGrid({ state })}
          ${ToolExecutionGroup({ state })}
        </div>
        ${ActivityTimeline({ state })}
        ${VerificationPanel({ state })}
        ${EvidenceDrawer({ state })}
        ${RunMetricsBar({ state })}
        ${CompletionSummary({ state })}
      </main>
    `;

    // Restore focus to equivalent control unless inside a dialog
    if (!isInsideDialog) {
      try {
        let restored: HTMLElement | null = null;
        if (activeId) {
          restored = container.querySelector(`#${CSS.escape(activeId)}`);
        } else if (activeDataAction) {
          restored = container.querySelector(`[data-action="${activeDataAction}"]`);
        } else if (activeRole && activeRole !== 'body') {
          restored = container.querySelector(`[role="${activeRole}"]`);
        }

        if (restored && typeof restored.focus === 'function') {
          restored.focus();
          if (selectionStart !== null && selectionEnd !== null && ('setSelectionRange' in restored)) {
            (restored as HTMLInputElement).setSelectionRange(selectionStart, selectionEnd);
          }
        }
      } catch {
        // Fallback silently if selector escaping fails
      }
    }
  };

  // Safe Event Delegation registered ONCE on container root
  const handleClick = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const cancelBtn = target.closest('[data-action="cancel-run"]');
    if (cancelBtn) {
      if (options.onCancelRun && options.runId) {
        options.onCancelRun(options.runId);
      }
    }
  };

  container.addEventListener('click', handleClick);

  // Instantiate Browser SSE Client
  const client = new FlowDeckStreamClient({
    url: sseUrl,
    headers: options.headers,
    onStateChange: (connState) => {
      state = { ...state, connectionState: connState };
      render();
    },
    onEvent: (event: FlowDeckStreamEvent) => {
      state = reduceRunStreamEvent(state, event);
      render();
    },
    onError: (err) => {
      state = { ...state, errors: [...state.errors, err.message] };
      render();
    },
  });

  // Initial render
  render();

  // Start SSE stream if feature flag enabled
  if (options.featureFlagEnabled !== false) {
    client.start();
  }

  return {
    getState: () => state,
    applyEvent: (event: FlowDeckStreamEvent) => {
      state = reduceRunStreamEvent(state, event);
      render();
    },
    destroy: () => {
      client.abort();
      container.removeEventListener('click', handleClick);
      container.innerHTML = '';
    },
  };
}
