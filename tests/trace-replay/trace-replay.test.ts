import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { FakeClock } from '../orchestration/fake/fake-clock';
import { FakeUuidGenerator } from '../orchestration/fake/fake-uuid';
import {
  TraceEvent,
  replayTrace,
  validateEventOrder,
  validateReproducibility,
} from '../../src/orchestration/runtime/trace-replay';

const BASELINE_SHA = '5809fcf1230ff349ff0d7f5b53ed75403f44573b';

class FakeModelAdapter {
  private responses: Map<string, unknown> = new Map();
  private callLog: Array<{ input: unknown; output: unknown; timestamp: number }> = [];

  registerResponse(prompt: string, response: unknown): void {
    this.responses.set(prompt, response);
  }

  async complete(input: unknown): Promise<unknown> {
    const timestamp = Date.now();
    const response = this.responses.get(JSON.stringify(input)) ?? {
      status: 'success',
      output: 'fake completion',
    };
    this.callLog.push({ input, output: response, timestamp });
    return response;
  }

  getCallLog() {
    return this.callLog;
  }

  reset(): void {
    this.responses.clear();
    this.callLog = [];
  }
}

class FakeToolAdapter {
  private toolImplementations: Map<string, (args: unknown) => unknown> = new Map();
  private callLog: Array<{ tool: string; args: unknown; result: unknown; timestamp: number }> = [];

  registerTool(name: string, impl: (args: unknown) => unknown): void {
    this.toolImplementations.set(name, impl);
  }

  async executeTool(name: string, args: unknown): Promise<unknown> {
    const timestamp = Date.now();
    const impl = this.toolImplementations.get(name);
    if (!impl) {
      throw new Error(`Tool not registered: ${name}`);
    }
    const result = impl(args);
    this.callLog.push({ tool: name, args, result, timestamp });
    return result;
  }

  getCallLog() {
    return this.callLog;
  }

  reset(): void {
    this.toolImplementations.clear();
    this.callLog = [];
  }
}

function createDeterministicTrace(scenarioId: string): TraceEvent[] {
  const baseTime = 1700000000000;
  return [
    {
      id: 'e1',
      type: 'task_started',
      timestamp: baseTime,
      payload: { scenarioId, gitSha: BASELINE_SHA },
    },
    {
      id: 'e2',
      type: 'specialist_invoked',
      timestamp: baseTime + 100,
      payload: { specialist: 'planner', task: 'analyze' },
      agentId: 'planner',
    },
    {
      id: 'e3',
      type: 'tool_called',
      timestamp: baseTime + 200,
      payload: { tool: 'read_file', args: { path: 'src/index.ts' } },
      toolName: 'read_file',
      toolArgs: { path: 'src/index.ts' },
    },
    {
      id: 'e4',
      type: 'tool_result',
      timestamp: baseTime + 300,
      payload: { tool: 'read_file', result: 'file contents' },
      toolName: 'read_file',
      toolResult: 'file contents',
    },
    {
      id: 'e5',
      type: 'specialist_completed',
      timestamp: baseTime + 400,
      payload: { specialist: 'planner', result: 'analysis complete' },
      agentId: 'planner',
    },
    {
      id: 'e6',
      type: 'verification_started',
      timestamp: baseTime + 500,
      payload: {},
    },
    {
      id: 'e7',
      type: 'task_completed',
      timestamp: baseTime + 600,
      payload: { status: 'success' },
    },
  ];
}

function createFailureTrace(scenarioId: string): TraceEvent[] {
  const baseTime = 1700000000000;
  return [
    {
      id: 'fe1',
      type: 'task_started',
      timestamp: baseTime,
      payload: { scenarioId, gitSha: BASELINE_SHA },
    },
    {
      id: 'fe2',
      type: 'specialist_invoked',
      timestamp: baseTime + 100,
      payload: { specialist: 'executor', task: 'make-change' },
      agentId: 'executor',
    },
    {
      id: 'fe3',
      type: 'tool_called',
      timestamp: baseTime + 200,
      payload: { tool: 'edit_file', args: { path: 'src/buggy.ts' } },
      toolName: 'edit_file',
      toolArgs: { path: 'src/buggy.ts' },
    },
    {
      id: 'fe4',
      type: 'tool_error',
      timestamp: baseTime + 300,
      payload: { tool: 'edit_file', error: 'File not found' },
      toolName: 'edit_file',
      error: 'File not found',
    },
    {
      id: 'fe5',
      type: 'specialist_failed',
      timestamp: baseTime + 400,
      payload: { specialist: 'executor', error: 'Tool execution failed' },
      agentId: 'executor',
      error: 'Tool execution failed',
    },
    {
      id: 'fe6',
      type: 'task_completed',
      timestamp: baseTime + 500,
      payload: { status: 'failure', error: 'Tool execution failed' },
    },
  ];
}

describe('Trace Replay', () => {
  let model: FakeModelAdapter;
  let tools: FakeToolAdapter;
  let clock: FakeClock;
  let db: Database;

  beforeEach(() => {
    model = new FakeModelAdapter();
    tools = new FakeToolAdapter();
    clock = new FakeClock(1700000000000);
    db = new Database(':memory:');

    db.exec(`
      CREATE TABLE traces (
        id TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL,
        events TEXT NOT NULL,
        baseline_sha TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE replay_results (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        replayed_events TEXT NOT NULL,
        error_count INTEGER NOT NULL,
        final_state TEXT NOT NULL,
        replayed_at INTEGER NOT NULL
      );
    `);

    tools.registerTool('read_file', (args: unknown) => {
      return `Contents of ${(args as { path: string }).path}`;
    });
    tools.registerTool('edit_file', (args: unknown) => {
      const path = (args as { path: string }).path;
      if (path.includes('buggy')) {
        throw new Error('File not found');
      }
      return { success: true, path };
    });
    tools.registerTool('write_file', (args: unknown) => {
      return { success: true, path: (args as { path: string }).path };
    });
  });

  afterEach(async () => {
    model.reset();
    tools.reset();
    db.close();
  });

  describe('Deterministic Replay', () => {
    it('replays trace with identical event sequence', async () => {
      const trace = createDeterministicTrace('test-scenario');
      const uuid = new FakeUuidGenerator();
      const traceId = uuid.generate();

      db.prepare(
        `INSERT INTO traces (id, scenario_id, events, baseline_sha, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(traceId, 'test-scenario', JSON.stringify(trace), BASELINE_SHA, clock.now());

      const result = await replayTrace(trace, model, tools, clock);

      expect(result.events.length).toBe(trace.length);
      expect(validateReproducibility(trace, result.events)).toBe(true);
    });

    it('produces same final state on repeated replays', async () => {
      const trace = createDeterministicTrace('test-scenario');
      const clock1 = new FakeClock(1700000000000);
      const clock2 = new FakeClock(1700000000000);

      const result1 = await replayTrace(trace, model, tools, clock1);
      const result2 = await replayTrace(trace, model, tools, clock2);

      expect(result1.finalState).toEqual(result2.finalState);
    });

    it('event order is preserved during replay', async () => {
      const trace = createDeterministicTrace('test-scenario');
      const result = await replayTrace(trace, model, tools, clock);

      expect(validateEventOrder(trace, result.events)).toBe(true);
    });
  });

  describe('Reproducible Failure Scenarios', () => {
    it('reproduces tool failure scenario', async () => {
      const failureTrace = createFailureTrace('failure-scenario');
      const result = await replayTrace(failureTrace, model, tools, clock);

      expect(result.errorCount).toBe(3); // tool throws in catch + tool_error + specialist_failed
      expect(result.finalState).toMatchObject({ finalStatus: 'failure' });
    });

    it('captures error context in replay', async () => {
      const failureTrace = createFailureTrace('failure-scenario');
      const result = await replayTrace(failureTrace, model, tools, clock);

      const errorEvents = result.events.filter((e) => e.error !== undefined);
      expect(errorEvents.length).toBe(3); // catch block + tool_error + specialist_failed
      expect(errorEvents[0].error).toContain('File not found');
    });

    it('replays failure trace deterministically', async () => {
      const failureTrace = createFailureTrace('failure-scenario');
      const clock1 = new FakeClock(1700000000000);
      const clock2 = new FakeClock(1700000000000);

      const result1 = await replayTrace(failureTrace, model, tools, clock1);
      const result2 = await replayTrace(failureTrace, model, tools, clock2);

      expect(result1.errorCount).toBe(result2.errorCount);
      expect(result1.finalState).toEqual(result2.finalState);
    });
  });

  describe('Event Order Validation', () => {
    it('validates chronological ordering', async () => {
      const trace = createDeterministicTrace('ordering-test');
      expect(validateEventOrder(trace, trace)).toBe(true);
    });

    it('detects out-of-order events', async () => {
      const trace = createDeterministicTrace('ordering-test');
      // Create deterministic "shuffled" array with out-of-order timestamps
      const shuffled = trace.map((e, i) => ({ ...e, timestamp: i === 0 ? e.timestamp + 1000 : e.timestamp - 100 }));
      expect(validateEventOrder(trace, shuffled)).toBe(false);
    });

    it('preserves specialist invocation order', async () => {
      const trace = createDeterministicTrace('specialist-order');
      const result = await replayTrace(trace, model, tools, clock);

      const specialistEvents = result.events.filter((e) => e.type === 'specialist_invoked');
      for (let i = 1; i < specialistEvents.length; i++) {
        expect(specialistEvents[i].timestamp).toBeGreaterThanOrEqual(
          specialistEvents[i - 1].timestamp
        );
      }
    });

    it('preserves tool call order within specialist execution', async () => {
      const trace = createDeterministicTrace('tool-order');
      const result = await replayTrace(trace, model, tools, clock);

      const toolCalls = result.events.filter((e) => e.type === 'tool_called');
      for (let i = 1; i < toolCalls.length; i++) {
        expect(toolCalls[i].timestamp).toBeGreaterThanOrEqual(toolCalls[i - 1].timestamp);
      }
    });
  });

  describe('Model and Tool Adapters', () => {
    it('model adapter logs all calls', async () => {
      model.registerResponse(JSON.stringify('test-input'), { status: 'ok' });
      await model.complete('test-input');

      const log = model.getCallLog();
      expect(log.length).toBe(1);
      expect(log[0].output).toEqual({ status: 'ok' });
    });

    it('tool adapter executes registered tools', async () => {
      const result = await tools.executeTool('read_file', { path: 'test.txt' });
      expect(result).toContain('Contents of test.txt');
    });

    it('tool adapter throws for unregistered tools', async () => {
      await expect(tools.executeTool('nonexistent', {})).rejects.toThrow('Tool not registered');
    });

    it('tool adapter logs all executions', async () => {
      await tools.executeTool('read_file', { path: 'test.txt' });
      const log = tools.getCallLog();
      expect(log.length).toBe(1);
      expect(log[0].tool).toBe('read_file');
    });
  });

  describe('Baseline Comparison', () => {
    it('matches baseline SHA in trace metadata', () => {
      const trace = createDeterministicTrace('sha-test');
      const firstEvent = trace[0];
      expect((firstEvent.payload as { gitSha: string }).gitSha).toBe(BASELINE_SHA);
    });

    it('replay produces same event count as original', async () => {
      const trace = createDeterministicTrace('count-test');
      const result = await replayTrace(trace, model, tools, clock);
      expect(result.events.length).toBe(trace.length);
    });

    it('replay preserves event type distribution', async () => {
      const trace = createDeterministicTrace('distribution-test');
      const result = await replayTrace(trace, model, tools, clock);

      const originalTypes = trace.map((e) => e.type);
      const replayedTypes = result.events.map((e) => e.type);

      const originalDist = new Map<string, number>();
      const replayedDist = new Map<string, number>();

      for (const t of originalTypes) {
        originalDist.set(t, (originalDist.get(t) ?? 0) + 1);
      }
      for (const t of replayedTypes) {
        replayedDist.set(t, (replayedDist.get(t) ?? 0) + 1);
      }

      expect(originalDist).toEqual(replayedDist);
    });
  });
});
