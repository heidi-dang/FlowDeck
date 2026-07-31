import { execSync } from "child_process";

export interface ValidationResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  passed: boolean;
  error: string | null;
}

const PATH_ESCAPE_PATTERN = /[&|;$\x27"()<>`]|\.\./;
const SHELL_INJECTION_PATTERN = /[&|;$\x27"()<>`]/;

function _isPathTraversalSafe(path: string): boolean {
  return !PATH_ESCAPE_PATTERN.test(path);
}

function isCommandSafe(command: string): boolean {
  if (command.includes("..")) return false;
  return !SHELL_INJECTION_PATTERN.test(command);
}

export function executeValidation(
  command: string,
  cwd: string,
  timeoutMs = 30_000,
): ValidationResult {
  if (!isCommandSafe(command)) {
    return {
      command,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      passed: false,
      error: 'Command rejected: contains shell injection patterns',
    };
  }

  const startTime = Date.now();
  try {
    const output = execSync(command, {
      cwd,
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: "pipe",
    });
    const durationMs = Date.now() - startTime;
    return {
      command,
      exitCode: 0,
      stdout: output,
      stderr: '',
      durationMs,
      passed: true,
      error: null,
    };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    if (err instanceof Error) {
      const execErr = err as Error & { status?: number; stdout?: string; stderr?: string };
      return {
        command,
        exitCode: execErr.status ?? 1,
        stdout: execErr.stdout ?? '',
        stderr: execErr.stderr ?? err.message,
        durationMs,
        passed: false,
        error: err.message,
      };
    }
    return {
      command,
      exitCode: 1,
      stdout: '',
      stderr: String(err),
      durationMs,
      passed: false,
      error: String(err),
    };
  }
}


