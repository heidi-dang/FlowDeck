import type { FlowDeckStreamEvent } from "./stream-event";

export type Stage = 'intake' | 'context' | 'plan' | 'execute' | 'verify' | 'complete';
export type StageState = 'pending' | 'active' | 'completed' | 'warning' | 'failed' | 'blocked' | 'skipped';

export interface AgentActivityState {
  id: string;
  agentId: string;
  responsibility: string;
  durationMs: number;
  currentOperation: string;
  result?: string;
  tokenUsage: number;
  toolsUsed: number;
  status: 'idle' | 'working' | 'done' | 'error';
}

export interface ToolExecutionState {
  id: string;
  toolName: string;
  args: any;
  output?: string;
  status: 'running' | 'success' | 'failed';
  durationMs: number;
}

export interface VerificationCheckState {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  details?: string;
}

export interface RunMetricsState {
  elapsedMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  toolCalls: number;
  filesInspected: number;
  filesChanged: number;
  testsPassed: number;
}

export interface RunProjectionState {
  runId: string | null;
  title: string | null;
  currentStage: Stage | null;
  stageStates: Record<Stage, StageState>;
  currentOperation: string;
  agentActivities: Record<string, AgentActivityState>;
  toolExecutions: Record<string, ToolExecutionState>;
  verificationChecks: Record<string, VerificationCheckState>;
  metrics: RunMetricsState;
  connectionState: string;
  lastSequence: number;
  terminalState: 'success' | 'failure' | 'cancelled' | null;
  errors: string[];
}

export const initialRunProjectionState: RunProjectionState = {
  runId: null,
  title: null,
  currentStage: null,
  stageStates: {
    intake: 'pending',
    context: 'pending',
    plan: 'pending',
    execute: 'pending',
    verify: 'pending',
    complete: 'pending',
  },
  currentOperation: 'Idle',
  agentActivities: {},
  toolExecutions: {},
  verificationChecks: {},
  metrics: {
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    toolCalls: 0,
    filesInspected: 0,
    filesChanged: 0,
    testsPassed: 0,
  },
  connectionState: 'idle',
  lastSequence: -1,
  terminalState: null,
  errors: [],
};

export const INITIAL_STATE = initialRunProjectionState;

export function reduceRunStreamEvent(state: RunProjectionState, event: FlowDeckStreamEvent): RunProjectionState {
  if (event.sequence <= state.lastSequence) {
    return state; // Idempotent
  }

  let nextState = { ...state, lastSequence: event.sequence };
  const p: any = event.payload || (event as any).data || {};

  if (event.metrics) {
    nextState.metrics = {
      ...nextState.metrics,
      elapsedMs: event.metrics.elapsedMs ?? nextState.metrics.elapsedMs,
      inputTokens: (nextState.metrics.inputTokens || 0) + (event.metrics.inputTokens || 0),
      outputTokens: (nextState.metrics.outputTokens || 0) + (event.metrics.outputTokens || 0),
      estimatedCostUsd: (nextState.metrics.estimatedCostUsd || 0) + (event.metrics.estimatedCostUsd || 0),
      toolCalls: (nextState.metrics.toolCalls || 0) + (event.metrics.toolCalls || 0),
    };
  }

  switch (event.type) {
    case 'run.started':
    case 'run.created':
      nextState.runId = event.runId || p.runId;
      nextState.title = event.title || p.title || null;
      nextState.currentStage = 'intake';
      nextState.stageStates = { ...nextState.stageStates, intake: 'active' };
      nextState.currentOperation = event.title || 'Initializing run';
      break;

    case 'stage.entered':
      if (nextState.currentStage && nextState.currentStage !== event.stage) {
        nextState.stageStates = { ...nextState.stageStates, [nextState.currentStage]: 'completed' };
      }
      nextState.currentStage = (event.stage as Stage) || (p.stage as Stage) || 'execute';
      nextState.stageStates = { ...nextState.stageStates, [nextState.currentStage]: 'active' };
      nextState.currentOperation = event.title || `Entered stage ${nextState.currentStage}`;
      break;

    case 'stage.progress':
      nextState.currentOperation = event.title || p.operation || nextState.currentOperation;
      break;

    case 'stage.completed':
      if (event.stage) {
        nextState.stageStates = { ...nextState.stageStates, [event.stage as Stage]: 'completed' };
      }
      break;

    case 'agent.started':
    case 'agent.queued':
      {
        const agentId = p.id || p.agentId || event.assignmentId || `agent-${event.sequence}`;
        nextState.agentActivities = {
          ...nextState.agentActivities,
          [agentId]: {
            id: agentId,
            agentId,
            responsibility: event.title || p.responsibility || 'Task assignment',
            durationMs: 0,
            currentOperation: event.summary || p.operation || 'Started agent execution',
            tokenUsage: 0,
            toolsUsed: 0,
            status: 'working',
          },
        };
      }
      break;

    case 'agent.progress':
      {
        const agentId = p.id || p.agentId || event.assignmentId;
        if (agentId && nextState.agentActivities[agentId]) {
          nextState.agentActivities = {
            ...nextState.agentActivities,
            [agentId]: {
              ...nextState.agentActivities[agentId],
              currentOperation: event.title || p.operation || nextState.agentActivities[agentId].currentOperation,
              ...p.updates,
            },
          };
        }
      }
      break;

    case 'agent.completed':
      {
        const agentId = p.id || p.agentId || event.assignmentId;
        if (agentId && nextState.agentActivities[agentId]) {
          nextState.agentActivities = {
            ...nextState.agentActivities,
            [agentId]: {
              ...nextState.agentActivities[agentId],
              status: 'done',
              result: p.result || event.summary,
              durationMs: p.durationMs || nextState.agentActivities[agentId].durationMs,
            },
          };
        }
      }
      break;

    case 'tool.started':
    case 'tool.queued':
      {
        const toolId = p.id || `tool-${event.sequence}`;
        nextState.toolExecutions = {
          ...nextState.toolExecutions,
          [toolId]: {
            id: toolId,
            toolName: p.toolName || event.title || 'tool',
            args: p.args,
            status: 'running',
            durationMs: 0,
          },
        };
        const agentId = p.agentId || event.assignmentId;
        if (agentId && nextState.agentActivities[agentId]) {
          nextState.agentActivities = {
            ...nextState.agentActivities,
            [agentId]: {
              ...nextState.agentActivities[agentId],
              toolsUsed: nextState.agentActivities[agentId].toolsUsed + 1,
            },
          };
        }
      }
      break;

    case 'tool.completed':
      {
        const toolId = p.id || `tool-${event.sequence}`;
        if (nextState.toolExecutions[toolId]) {
          nextState.toolExecutions = {
            ...nextState.toolExecutions,
            [toolId]: {
              ...nextState.toolExecutions[toolId],
              status: 'success',
              output: p.output || event.summary,
              durationMs: p.durationMs || 0,
            },
          };
        }
      }
      break;

    case 'verification.started':
    case 'verification.check_started':
      {
        const checkId = p.id || `check-${event.sequence}`;
        nextState.verificationChecks = {
          ...nextState.verificationChecks,
          [checkId]: {
            id: checkId,
            name: event.title || p.name || 'Check',
            status: 'running',
          },
        };
      }
      break;

    case 'verification.check_completed':
    case 'verification.completed':
      {
        const checkId = p.id || `check-${event.sequence}`;
        if (nextState.verificationChecks[checkId]) {
          nextState.verificationChecks = {
            ...nextState.verificationChecks,
            [checkId]: {
              ...nextState.verificationChecks[checkId],
              status: p.passed !== false ? 'passed' : 'failed',
              details: p.details || event.summary,
            },
          };
        }
      }
      break;

    case 'metrics.updated':
      nextState.metrics = {
        ...nextState.metrics,
        ...p.metrics,
      };
      break;

    case 'run.completed':
      if (nextState.currentStage) {
        nextState.stageStates = { ...nextState.stageStates, [nextState.currentStage]: 'completed' };
      }
      nextState.currentStage = 'complete';
      nextState.stageStates = { ...nextState.stageStates, complete: 'completed' };
      nextState.terminalState = 'success';
      nextState.currentOperation = 'Run completed successfully';
      break;

    case 'run.failed':
      if (nextState.currentStage) {
        nextState.stageStates = { ...nextState.stageStates, [nextState.currentStage]: 'failed' };
      }
      nextState.terminalState = 'failure';
      if (p.error || event.summary) {
        nextState.errors = [...nextState.errors, p.error || event.summary || 'Run failed'];
      }
      nextState.currentOperation = 'Run failed';
      break;

    case 'run.cancelled':
      if (nextState.currentStage) {
        nextState.stageStates = { ...nextState.stageStates, [nextState.currentStage]: 'blocked' };
      }
      nextState.terminalState = 'cancelled';
      nextState.currentOperation = 'Run cancelled';
      break;
  }

  return nextState;
}

export const selectActiveStage = (state: RunProjectionState): Stage | null => state.currentStage;
export const selectCurrentOperation = (state: RunProjectionState): string => state.currentOperation;
export const selectAgentSummary = (state: RunProjectionState): AgentActivityState[] => Object.values(state.agentActivities);
export const selectVerificationSummary = (state: RunProjectionState): VerificationCheckState[] => Object.values(state.verificationChecks);
export const selectMetrics = (state: RunProjectionState): RunMetricsState => state.metrics;
