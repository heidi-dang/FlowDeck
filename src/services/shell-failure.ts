/**
 * Shell failure propagation primitives.
 *
 * Bridges the execution layer (shell-executor now reports non-zero exits as a
 * failed result) into the coordinator / UI / recovery layers. It owns:
 *   - safe, redacted failure description (no secrets, no hidden CoT);
 *   - stable semantic failure fingerprint (tool + effective command +
 *     repository generation + failure class) used to prevent same-command
 *     retry churn and to record a recovery incident exactly once;
 *   - a per-session failure tracker that guarantees bounded recovery and
 *     strategy-change bookkeeping.
 *
 * Framework-agnostic: nothing here imports @opencode-ai/plugin.
 */
import { redactSecrets } from "../lib/secret-redaction"

export type ShellFailureClass =
  | "nonzero_exit"
  | "timeout"
  | "max_buffer_exceeded"
  | "executable_not_found"

export interface ShellFailureInfo {
  status: "failed"
  exitCode: number
  /** Redacted stderr. Never raw secrets. */
  stderr: string
  command: string
  sessionID: string
  callID?: string
  toolName: string
  repoGeneration?: string
  at: number
}

export interface ShellFailureDecision {
  fingerprint: string
  /** First occurrence of this fingerprint in this session. */
  incidentCreated: boolean
  /** This fingerprint has already been seen; a repeat risk. */
  isRepeat: boolean
  /** Exactly how many times this exact fingerprint has been handled. */
  repeatCount: number
  /** Distinct strategy attempts for this session after failures. */
  strategyAttempt: number
  /** Every failed command must not be repeated unchanged. */
  strategyShouldChange: boolean
}

/** Collapse a command to a stable, display-safe effective token sequence. */
export function normalizeEffectiveCommand(command: string): string {
  return (command ?? "")
    .replace(/\s+/g, " ")
    .replace(/['"]/g, "")
    .trim()
    .slice(0, 400)
}

/**
 * Stable semantic failure fingerprint. Intended to recognize
 * "same tool + same effective command + same repository generation + same
 * failure class" so a repeated unchanged command is not treated as new work.
 * Built from sanitized inputs only — never embed raw secrets. Not a hash that
 * needs cryptographic strength; determinism and stability are what matter.
 */
export function shellSemanticFingerprint(input: {
  toolName: string
  command: string
  repoGeneration?: string
  exitCode: number
  stderr?: string
}): string {
  const tool = (input.toolName || "shell").toLowerCase().trim()
  const effective = normalizeEffectiveCommand(input.command)
  const gen = input.repoGeneration ?? "default"
  const cls: ShellFailureClass = "nonzero_exit"
  const errSig = (input.stderr ?? "").replace(/\s+/g, " ").trim().slice(0, 80)
  const exit = Number.isFinite(input.exitCode) ? input.exitCode : typeof input.exitCode === "number" ? input.exitCode : -1
  let h = 0
  const seed = tool + "|" + effective + "|" + gen + "|" + cls + "|" + exit + "|" + errSig
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0
  }
  return tool + ":" + effective.slice(0, 40) + "|" + h.toString(16)
}

/** Safe, model-visible failure description. Bounded operational facts only. */
export function describeShellFailure(info: ShellFailureInfo): string {
  const cmd = normalizeEffectiveCommand(info.command)
  const lines = [
    "Command failed with exit code " + info.exitCode + ".",
    "Failed command: " + cmd,
  ]
  const err = (info.stderr ?? "").trim()
  if (err) {
    lines.push("stderr:")
    lines.push(err)
  }
  lines.push("Do not repeat the same command unchanged. Inspect the error and choose a valid alternative.")
  return lines.join("\n")
}

/** Compact WebUI row label, e.g. "shell cargo --coverage — Failed · exit 1". */
export function describeShellFailureTitle(info: ShellFailureInfo): string {
  return (info.toolName || "shell") + " " + normalizeEffectiveCommand(info.command) + " \u2014 Failed \u00b7 exit " + info.exitCode
}

/**
 * Build a ShellFailureInfo from an execution-layer result. Redacts stderr so
 * secrets never reach the model, the UI, telemetry, or a replay.
 */
export function normalizeShellFailure(
  result: { status: string; exitCode: number; stderr?: string; output?: string },
  meta: { command: string; sessionID: string; callID?: string; toolName: string; repoGeneration?: string },
): ShellFailureInfo {
  return {
    status: "failed",
    exitCode: result.exitCode,
    stderr: redactSecrets(result.stderr ?? result.output ?? ""),
    command: meta.command,
    sessionID: meta.sessionID,
    callID: meta.callID,
    toolName: meta.toolName,
    repoGeneration: meta.repoGeneration,
    at: Date.now(),
  }
}

/**
 * Deterministic per-session failure tracker.
 *
 * Guarantees:
 *  - a recovery incident is created exactly ONCE per fingerprint per session;
 *  - a repeated identical failure never triggers a new continuation flood;
 *  - every failed command forces a strategy change (never repeat unchanged);
 *  - healthy sessions are untouched (record() is only called on a failure).
 */
export class ShellFailureTracker {
  private bySession = new Map<string, Map<string, { count: number; incidentCreated: boolean }>>()
  private strategyAttempts = new Map<string, number>()

  record(info: ShellFailureInfo): ShellFailureDecision {
    const key = info.sessionID || "no-session"
    const fingerprint = shellSemanticFingerprint({
      toolName: info.toolName,
      command: info.command,
      repoGeneration: info.repoGeneration,
      exitCode: info.exitCode,
      stderr: info.stderr,
    })
    let perFp = this.bySession.get(key)
    if (!perFp) {
      perFp = new Map()
      this.bySession.set(key, perFp)
    }
    const existing = perFp.get(fingerprint)
    if (!existing) {
      perFp.set(fingerprint, { count: 1, incidentCreated: true })
      const strategyAttempt = (this.strategyAttempts.get(key) ?? 0) + 1
      this.strategyAttempts.set(key, strategyAttempt)
      return {
        fingerprint,
        incidentCreated: true,
        isRepeat: false,
        repeatCount: 1,
        strategyAttempt,
        strategyShouldChange: true,
      }
    }
    existing.count += 1
    return {
      fingerprint,
      incidentCreated: false,
      isRepeat: existing.count > 1,
      repeatCount: existing.count,
      strategyAttempt: this.strategyAttempts.get(key) ?? 1,
      strategyShouldChange: true,
    }
  }

  /** Number of distinct strategy attempts (distinct failed commands) for a session. */
  strategyAttemptsFor(sessionID: string): number {
    return this.strategyAttempts.get(sessionID ?? "no-session") ?? 0
  }

  /** Total recovery incidents created across all sessions. */
  incidentCount(): number {
    let n = 0
    for (const perFp of this.bySession.values()) {
      for (const rec of perFp.values()) if (rec.incidentCreated) n += 1
    }
    return n
  }

  clearSession(sessionID: string): void {
    this.bySession.delete(sessionID ?? "no-session")
    this.strategyAttempts.delete(sessionID ?? "no-session")
  }

  clearAll(): void {
    this.bySession.clear()
    this.strategyAttempts.clear()
  }
}
