/**
 * ShellExecutor — the FlowDeck-owned bash/shell command executor used by the
 * plugin integration. Routes recognized safe shell commands through the
 * ToolFastLane semantic adapters so they execute with ZERO bash subprocess
 * spawns; genuinely unsafe / uncertain commands fall back to a real bash
 * shell. Framework-agnostic: it does NOT import @opencode-ai/plugin.
 */
import { execFileSync } from "node:child_process";
import * as fastLane from "./tool-fast-lane";
import type { FastRewriteAdapter } from "./tool-fast-lane";

const { rewriteShellCommand, rewriteLsCommand, executeFastRewrite } = fastLane;

export interface ShellToolDeps {
  cwd: string;
}

export type ShellExecutionStatus = "ok" | "failed";

/**
 * Result of a shell command. A non-zero process exit is NEVER normalized to
 * a successful completion: such a run reports status "failed" with the exact
 * exitCode and a copy of stderr. Distinguish "the process launched" from
 * "the command succeeded" (process spawn success != command execution success).
 */
export interface ShellExecutionResult {
  output: string;
  bashSpawned: boolean;
  adapter?: FastRewriteAdapter | null;
  /** "ok" when the command completed with exit code 0; "failed" when it exited non-zero. */
  status: ShellExecutionStatus;
  /** Exact process exit code. 0 when successful; the precise code when failed. */
  exitCode: number;
  /** stderr captured from the process (empty for fast-lane semantic rewrites). */
  stderr: string;
}

/**
 * Execute a shell command. If it is a safe, recognized rewrite (cat, sed -n,
 * grep, git status/diff/log, ls) it runs the semantic adapter in-process or
 * via execFileSync("git") — bashSpawned=false and bashSpawnCount is untouched.
 * Otherwise it runs `bash -lc <command>` with a 120s timeout, increments
 * bashSpawnCount, and reports bashSpawned=true. Spawn errors are captured into
 * the returned output rather than thrown spuriously.
 */
export function executeShellCommand(
  command: string,
  deps: ShellToolDeps,
): ShellExecutionResult {
  const rewrite = rewriteShellCommand(command) ?? rewriteLsCommand(command);
  if (rewrite) {
    try {
      const output = executeFastRewrite(rewrite, deps.cwd);
      return { output, bashSpawned: false, adapter: rewrite.adapter, status: "ok", exitCode: 0, stderr: "" };
    } catch {
      // Rewrite matched but execution failed (e.g. missing file / not a git
      // repo). Fall back to a real bash shell so the caller still gets a result.
    }
  }
  return runBash(command, deps);
}

function runBash(command: string, deps: ShellToolDeps): ShellExecutionResult {
  fastLane.addBashSpawnCount(1);
  try {
    const output = execFileSync("bash", ["-lc", command], {
      cwd: deps.cwd,
      encoding: "utf8",
      timeout: 120_000,
    });
    return { output, bashSpawned: true, adapter: null, status: "ok", exitCode: 0, stderr: "" };
  } catch (err: any) {
    const oe = err?.stdout ? err.stdout.toString() : "";
    const se = err?.stderr ? err.stderr.toString() : "";
    const combined = oe + (oe && se ? "\n" : "") + se;
    const exitCode = typeof err?.status === "number" && err.status > 0
      ? err.status
      : typeof err?.code === "number" && err.code !== "ENOENT" && err.code > 0
        ? err.code
        : 1;
    return {
      output: combined || (err?.message ?? String(err)),
      bashSpawned: true,
      adapter: null,
      status: "failed",
      exitCode,
      stderr: se,
    };
  }
}

/**
 * A plain framework-agnostic tool descriptor (name, description, args schema,
 * callback). Nothing here imports @opencode-ai/plugin; the integration layer
 * adapts this to whatever tool framework is in use.
 */
export function createFlowDeckBashTool(deps: ShellToolDeps): object {
  return {
    name: "shell",
    description: "Execute a bash/shell command. Safe read-only commands (cat, sed -n, grep, git status/diff/log, ls) run through the fast lane with no shell spawn.",
    args: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
        description: {
          type: "string",
          description: "Optional human-readable description of the command.",
        },
        cwd: {
          type: "string"
        }
      },
      required: ["command"],
    } as const,
    callback: (input: { command: string }) => {
      return executeShellCommand(input.command, deps).output;
    },
  };
}

export { resetBashSpawnCount, bashSpawnCount } from "./tool-fast-lane";
