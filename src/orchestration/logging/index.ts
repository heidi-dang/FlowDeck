export enum LogSeverity {
  DEBUG = "debug",
  INFO = "info",
  WARN = "warn",
  ERROR = "error",
  FATAL = "fatal",
}

export interface LogEntry {
  timestamp: string;
  level: LogSeverity;
  message: string;
  requestId?: string;
  correlationId?: string;
  causationId?: string;
  runId?: string;
  aggregateId?: string;
  eventId?: string;
  sessionId?: string;
  agentId?: string;
  component: string;
  durationMs?: number;
  error?: { message: string; code?: string; stack?: string };
  metadata?: Record<string, unknown>;
}

// ── Structured Logger ─────────────────────────────────────────────────────

export interface Logger {
  debug(msg: string, context?: Partial<LogEntry>): void;
  info(msg: string, context?: Partial<LogEntry>): void;
  warn(msg: string, context?: Partial<LogEntry>): void;
  error(msg: string, context?: Partial<LogEntry>): void;
  fatal(msg: string, context?: Partial<LogEntry>): void;
}

export class StructuredLogger implements Logger {
  private readonly component: string;

  constructor(component: string, private readonly transport?: (entry: LogEntry) => void) {
    this.component = component;
  }

  debug(msg: string, context?: Partial<LogEntry>): void { this.log(LogSeverity.DEBUG, msg, context); }
  info(msg: string, context?: Partial<LogEntry>): void { this.log(LogSeverity.INFO, msg, context); }
  warn(msg: string, context?: Partial<LogEntry>): void { this.log(LogSeverity.WARN, msg, context); }
  error(msg: string, context?: Partial<LogEntry>): void { this.log(LogSeverity.ERROR, msg, context); }
  fatal(msg: string, context?: Partial<LogEntry>): void { this.log(LogSeverity.FATAL, msg, context); }

  child(component: string): StructuredLogger {
    return new StructuredLogger(`${this.component}.${component}`, this.transport);
  }

  private log(level: LogSeverity, message: string, context?: Partial<LogEntry>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      component: this.component,
      ...context,
    };

    if (this.transport) {
      this.transport(entry);
    } else {
      // Default: JSON to stdout
      const output = JSON.stringify(entry);
      if (level === LogSeverity.ERROR || level === LogSeverity.FATAL) {
        console.error(output);
      } else if (level === LogSeverity.WARN) {
        console.warn(output);
      } else {
        console.log(output);
      }
    }
  }
}

// ── Console transport (human-readable) ────────────────────────────────────

export function createConsoleTransport(prettyPrint: boolean = false): (entry: LogEntry) => void {
  return (entry: LogEntry) => {
    if (prettyPrint) {
      const prefix = `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.component}]`;
      const suffix = entry.correlationId ? ` (corr: ${entry.correlationId})` : "";
      console.log(`${prefix} ${entry.message}${suffix}`);
    } else {
      console.log(JSON.stringify(entry));
    }
  };
}
