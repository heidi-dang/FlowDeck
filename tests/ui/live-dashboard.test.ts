import { describe, it, expect } from 'vitest';
import { 
  RunHeader, 
  StageRail, 
  CurrentOperationCard, 
  AgentActivityGrid, 
  ToolExecutionGroup, 
  VerificationPanel 
} from '../../src/better-harness/ui';
import { INITIAL_STATE, RunProjectionState } from '../../src/orchestration/streaming/projection';

describe('Live Dashboard UI Components', () => {
  const dummyState: RunProjectionState = {
    ...INITIAL_STATE,
    title: 'Test Dash',
    currentStage: 'plan',
    currentOperation: 'Generating plan',
    stageStates: {
      ...INITIAL_STATE.stageStates,
      intake: 'completed',
      context: 'completed',
      plan: 'active'
    },
    metrics: { elapsedMs: 5000, inputTokens: 1000, outputTokens: 200, estimatedCostUsd: 0.05, toolCalls: 5, filesInspected: 10, filesChanged: 2, testsPassed: 5 },
    connectionState: 'connected',
    agentActivities: {
      a1: {
        id: 'a1', agentId: 'dev', responsibility: 'coding', 
        durationMs: 1000, currentOperation: 'Thinking', tokenUsage: 100, 
        toolsUsed: 1, status: 'working'
      }
    },
    toolExecutions: {
      t1: {
        id: 't1', toolName: 'fs_read', args: {}, status: 'running', durationMs: 50
      }
    },
    verificationChecks: {
      v1: {
        id: 'v1', name: 'Lint', status: 'passed'
      }
    }
  };

  it('RunHeader should render title, metrics, and ARIA attributes', () => {
    const html = RunHeader({ state: dummyState });
    expect(html).toContain('Test Dash');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('1200'); // tokens
    expect(html).toContain('5000'); // time
  });

  it('StageRail should render all stages with correct states and aria labels', () => {
    const html = StageRail({ state: dummyState });
    expect(html).toContain('stage-completed');
    expect(html).toContain('stage-active');
    expect(html).toContain('aria-label="Run Stages"');
  });

  it('CurrentOperationCard should render sticky container and assertive aria-live', () => {
    const html = CurrentOperationCard({ state: dummyState });
    expect(html).toContain('Generating plan');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('position: sticky');
  });

  it('AgentActivityGrid should render agents with keyboard focusability', () => {
    const html = AgentActivityGrid({ state: dummyState });
    expect(html).toContain('dev');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Agent Activities"');
  });

  it('ToolExecutionGroup should render tools with focusable items', () => {
    const html = ToolExecutionGroup({ state: dummyState });
    expect(html).toContain('fs_read');
    expect(html).toContain('tabindex="0"');
  });

  it('VerificationPanel should render checks and live status', () => {
    const html = VerificationPanel({ state: dummyState });
    expect(html).toContain('Lint');
    expect(html).toContain('passed');
  });
});
