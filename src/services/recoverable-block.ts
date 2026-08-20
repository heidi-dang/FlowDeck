/**
 * FlowDeck Guard Recoverable Block Infrastructure
 *
 * Defines machine-readable, recoverable guard errors that provide structured feedback
 * to Heidi without crashing or ending the session.
 */

export type FlowDeckSubsystem =
  | "loop_detector"
  | "guard_rails"
  | "orchestrator_guard"
  | "governance"
  | "supervisor"
  | "tool_guard"

export interface RecoverableBlockOptions {
  subsystem: FlowDeckSubsystem
  code: string
  tool: string
  sessionID?: string
  agent?: string
  reason: string
  recoverable?: boolean
  terminal?: boolean
  requiresHuman?: boolean
  suggestedActions?: string[]
  details?: Record<string, unknown>
}

export class RecoverableFlowDeckBlockError extends Error {
  public readonly subsystem: FlowDeckSubsystem
  public readonly code: string
  public readonly tool: string
  public readonly sessionID: string
  public readonly agent: string
  public readonly recoverable: boolean
  public readonly terminal: boolean
  public readonly requiresHuman: boolean
  public readonly suggestedActions: string[]
  public readonly details: Record<string, unknown>

  constructor(options: RecoverableBlockOptions) {
    const isRecoverable = options.recoverable ?? true
    const isTerminal = options.terminal ?? false
    const label = isTerminal ? "Terminal Block" : isRecoverable ? "Recoverable Block" : "Block"

    super(`[FlowDeck ${options.subsystem} ${label}: ${options.code}] ${options.reason}`)
    this.name = "RecoverableFlowDeckBlockError"
    this.subsystem = options.subsystem
    this.code = options.code
    this.tool = options.tool
    this.sessionID = options.sessionID ?? ""
    this.agent = options.agent ?? "heidi"
    this.recoverable = isRecoverable
    this.terminal = isTerminal
    this.requiresHuman = options.requiresHuman ?? false
    this.suggestedActions = options.suggestedActions ?? [
      "Choose a different valid tool or action",
      "Inspect previous tool outputs or task instructions",
    ]
    this.details = options.details ?? {}
  }

  /**
   * Format machine-readable feedback for Heidi.
   */
  public toFeedbackString(): string {
    const lines: string[] = [
      `[FlowDeck Guard Notice - Action Required]`,
      `Tool operation '${this.tool}' was blocked by FlowDeck policy (${this.subsystem}).`,
      `Code: ${this.code}`,
      `Reason: ${this.message}`,
    ]

    if (this.suggestedActions.length > 0) {
      lines.push("Suggested Next Actions:")
      for (const act of this.suggestedActions) {
        lines.push(`- ${act}`)
      }
    }

    const isTerminal = this.terminal || !this.recoverable
    if (isTerminal) {
      lines.push("Heidi: This strategy/operation has been invalidated and cannot be retried unchanged. Please switch to an alternative allowed tool, delegate to a specialist agent, or report the blocker.")
    } else {
      lines.push("Heidi: Do NOT repeat this identical command unchanged — identical retries are blocked. Please choose an alternative valid tool (e.g. FDX/native read) or delegate to a specialist agent to continue your task.")
    }
    return lines.join("\n")
  }
}

export function isRecoverableBlockError(err: unknown): err is RecoverableFlowDeckBlockError {
  return (
    err instanceof Error &&
    (err.name === "RecoverableFlowDeckBlockError" ||
      ("subsystem" in err && "code" in err && "recoverable" in err))
  )
}
