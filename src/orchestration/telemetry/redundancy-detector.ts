import type { Span } from "../tracing/index.js";

// ── Trace types ────────────────────────────────────────────────────────────────

export interface ExecutionTrace {
  spans: Span[];
  toolQueries: ToolQuery[];
  specialistCalls: SpecialistCall[];
  commandExecutions: CommandExecution[];
  fileReads: FileRead[];
  contextAdditions: ContextAddition[];
  verificationSteps: VerificationStep[];
  startTime: number;
  endTime?: number;
}

export interface ToolQuery {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  timestamp: number;
  durationMs?: number;
  result?: unknown;
  error?: string;
}

export interface SpecialistCall {
  id: string;
  specialistName: string;
  input: unknown;
  output?: unknown;
  timestamp: number;
  durationMs?: number;
  error?: string;
}

export interface CommandExecution {
  id: string;
  command: string;
  args?: string[];
  timestamp: number;
  durationMs?: number;
  exitCode?: number;
  error?: string;
}

export interface FileRead {
  id: string;
  filePath: string;
  timestamp: number;
  bytesRead?: number;
  error?: string;
}

export interface ContextAddition {
  id: string;
  content: string;
  source: string;
  timestamp: number;
}

export interface VerificationStep {
  id: string;
  description: string;
  timestamp: number;
  passed?: boolean;
  error?: string;
}

// ── Redundancy report types ────────────────────────────────────────────────────

export interface RepeatedQuery {
  queryHash: string;
  count: number;
  toolName: string;
  arguments: Record<string, unknown>;
  timestamps: number[];
  totalDurationMs: number;
}

export interface DuplicateContextItem {
  contentHash: string;
  count: number;
  sources: string[];
  timestamps: number[];
}

export interface RepeatedCommand {
  commandHash: string;
  command: string;
  count: number;
  timestamps: number[];
  totalDurationMs: number;
}

export interface RepeatedFileRead {
  filePathHash: string;
  filePath: string;
  count: number;
  timestamps: number[];
  totalBytesRead: number;
}

export interface RedundancyReport {
  repeatedToolQueries: RepeatedQuery[];
  duplicateContext: DuplicateContextItem[];
  unnecessarySpecialists: string[];
  repeatedCommands: RepeatedCommand[];
  repeatedFileReads: RepeatedFileRead[];
  redundantVerification: string[];
  staleWork: string[];
}

// ── Hashing utilities ─────────────────────────────────────────────────────────

function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args).sort()) {
    if (typeof value === "object" && value !== null) {
      normalized[key] = JSON.stringify(value);
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

// ── Redundancy Detector ───────────────────────────────────────────────────────

export class RedundancyDetector {
  detect(trace: ExecutionTrace): RedundancyReport {
    return {
      repeatedToolQueries: this.detectRepeatedToolQueries(trace.toolQueries),
      duplicateContext: this.detectDuplicateContext(trace.contextAdditions),
      unnecessarySpecialists: this.detectUnnecessarySpecialists(trace),
      repeatedCommands: this.detectRepeatedCommands(trace.commandExecutions),
      repeatedFileReads: this.detectRepeatedFileReads(trace.fileReads),
      redundantVerification: this.detectRedundantVerification(trace),
      staleWork: this.detectStaleWork(trace),
    };
  }

  private detectRepeatedToolQueries(queries: ToolQuery[]): RepeatedQuery[] {
    const groups = new Map<string, ToolQuery[]>();

    for (const query of queries) {
      const normalizedArgs = normalizeArgs(query.arguments);
      const hash = hashString(JSON.stringify({ toolName: query.toolName, args: normalizedArgs }));
      const existing = groups.get(hash) ?? [];
      existing.push(query);
      groups.set(hash, existing);
    }

    const repeated: RepeatedQuery[] = [];

    for (const [hash, group] of groups) {
      if (group.length > 1) {
        const sorted = group.sort((a, b) => a.timestamp - b.timestamp);
        const totalDurationMs = group.reduce((sum, q) => sum + (q.durationMs ?? 0), 0);
        repeated.push({
          queryHash: hash,
          count: group.length,
          toolName: group[0].toolName,
          arguments: group[0].arguments,
          timestamps: sorted.map((q) => q.timestamp),
          totalDurationMs,
        });
      }
    }

    return repeated.sort((a, b) => b.count - a.count);
  }

  private detectDuplicateContext(additions: ContextAddition[]): DuplicateContextItem[] {
    const groups = new Map<string, ContextAddition[]>();

    for (const addition of additions) {
      const hash = hashString(addition.content.trim());
      const existing = groups.get(hash) ?? [];
      existing.push(addition);
      groups.set(hash, existing);
    }

    const duplicates: DuplicateContextItem[] = [];

    for (const [hash, group] of groups) {
      if (group.length > 1) {
        duplicates.push({
          contentHash: hash,
          count: group.length,
          sources: [...new Set(group.map((g) => g.source))],
          timestamps: group.map((g) => g.timestamp).sort((a, b) => a - b),
        });
      }
    }

    return duplicates.sort((a, b) => b.count - a.count);
  }

  private detectUnnecessarySpecialists(trace: ExecutionTrace): string[] {
    const specialists = new Map<string, { calls: SpecialistCall[]; errors: number }>();

    for (const call of trace.specialistCalls) {
      const existing = specialists.get(call.specialistName) ?? { calls: [], errors: 0 };
      existing.calls.push(call);
      if (call.error) existing.errors++;
      specialists.set(call.specialistName, existing);
    }

    const unnecessary: string[] = [];

    for (const [name, data] of specialists) {
      if (data.calls.length === 1 && data.errors > 0) {
        unnecessary.push(name);
      }
    }

    return unnecessary;
  }

  private detectRepeatedCommands(commands: CommandExecution[]): RepeatedCommand[] {
    const groups = new Map<string, CommandExecution[]>();

    for (const cmd of commands) {
      const hash = hashString(cmd.command + JSON.stringify(cmd.args ?? []));
      const existing = groups.get(hash) ?? [];
      existing.push(cmd);
      groups.set(hash, existing);
    }

    const repeated: RepeatedCommand[] = [];

    for (const [hash, group] of groups) {
      if (group.length > 1) {
        repeated.push({
          commandHash: hash,
          command: group[0].command,
          count: group.length,
          timestamps: group.map((c) => c.timestamp).sort((a, b) => a - b),
          totalDurationMs: group.reduce((sum, c) => sum + (c.durationMs ?? 0), 0),
        });
      }
    }

    return repeated.sort((a, b) => b.count - a.count);
  }

  private detectRepeatedFileReads(reads: FileRead[]): RepeatedFileRead[] {
    const groups = new Map<string, FileRead[]>();

    for (const read of reads) {
      const existing = groups.get(read.filePath) ?? [];
      existing.push(read);
      groups.set(read.filePath, existing);
    }

    const repeated: RepeatedFileRead[] = [];

    for (const [filePath, group] of groups) {
      if (group.length > 1) {
        repeated.push({
          filePathHash: hashString(filePath),
          filePath,
          count: group.length,
          timestamps: group.map((r) => r.timestamp).sort((a, b) => a - b),
          totalBytesRead: group.reduce((sum, r) => sum + (r.bytesRead ?? 0), 0),
        });
      }
    }

    return repeated.sort((a, b) => b.count - a.count);
  }

  private detectRedundantVerification(trace: ExecutionTrace): string[] {
    const verificationByDesc = new Map<string, VerificationStep[]>();

    for (const step of trace.verificationSteps) {
      const existing = verificationByDesc.get(step.description) ?? [];
      existing.push(step);
      verificationByDesc.set(step.description, existing);
    }

    const redundant: string[] = [];

    for (const [desc, steps] of verificationByDesc) {
      if (steps.length > 1) {
        const allPassed = steps.every((s) => s.passed === true);
        const allFailedSame = steps.every((s) => s.error === steps[0].error);
        if (allPassed || allFailedSame) {
          redundant.push(desc);
        }
      }
    }

    return redundant;
  }

  private detectStaleWork(trace: ExecutionTrace): string[] {
    const stale: string[] = [];
    const toolErrors = new Map<string, { count: number; lastError: string }>();

    for (const query of trace.toolQueries) {
      if (query.error) {
        const existing = toolErrors.get(query.toolName) ?? { count: 0, lastError: "" };
        existing.count++;
        existing.lastError = query.error;
        toolErrors.set(query.toolName, existing);
      }
    }

    for (const [toolName, data] of toolErrors) {
      if (data.count >= 3) {
        stale.push(`${toolName}: repeated failures (${data.count}x), last error: ${data.lastError}`);
      }
    }

    return stale;
  }
}
