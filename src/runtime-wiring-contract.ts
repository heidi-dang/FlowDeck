export type RuntimeFeatureStatus = "wired" | "deprecated"

export interface RuntimeFeatureContract {
  status: RuntimeFeatureStatus
  reason: string
  replacement?: string
}

/**
 * Audited runtime truth for legacy hook modules that are not part of the live
 * plugin graph. Keeping this explicit prevents test-only modules from being
 * mistaken for enabled production behavior.
 */
export const HOOK_RUNTIME_CONTRACT = {
  "command-ref-guard": {
    status: "deprecated",
    reason: "Command references are validated by the live planning and tool guards.",
    replacement: "guard-rails and tool-guard",
  },
  "context-window-monitor": {
    status: "deprecated",
    reason: "Context budgeting is handled by session-start and token-budget.",
    replacement: "token-budget",
  },
  notifications: {
    status: "deprecated",
    reason: "Desktop notifications are not enabled by the plugin lifecycle.",
  },
  "patch-trust": {
    status: "deprecated",
    reason: "Patch validation is enforced by tool-guard and verification-layer.",
    replacement: "tool-guard and verification-layer",
  },
  "session-idle-hook": {
    status: "deprecated",
    reason: "Idle lifecycle behavior is handled by session-events.",
    replacement: "session-events",
  },
  "shell-env-hook": {
    status: "deprecated",
    reason: "Shell policy is enforced without mutating the user's environment.",
    replacement: "orchestrator-guard-hook and shell-command-classifier",
  },
  "todo-hook": {
    status: "deprecated",
    reason: "Task progress is owned by planning-state rather than a hidden hook.",
    replacement: "planning-state",
  },
} as const satisfies Record<string, RuntimeFeatureContract>

/** Audited runtime truth for legacy services outside the live plugin graph. */
export const SERVICE_RUNTIME_CONTRACT = {
  "candidate-approval": {
    status: "deprecated",
    reason: "Candidate approval is not exposed in the current plugin lifecycle.",
  },
  "config-editor": {
    status: "deprecated",
    reason: "Configuration edits use the transactional installer and config mutator.",
    replacement: "config-transaction.mjs",
  },
  "heidi-execution-policy": {
    status: "deprecated",
    reason: "Runtime delegation is enforced by the coordinator prompt and governance guard.",
    replacement: "orchestrator and governance-wiring",
  },
  "model-router": {
    status: "deprecated",
    reason: "Model selection uses explicit per-agent configuration without heuristic routing.",
    replacement: "resolveAgentModels",
  },
  "preflight-explorer": {
    status: "deprecated",
    reason: "Repository discovery is performed directly by Heidi and FDX tools.",
    replacement: "fdx-search, fdx-tree, and fdx-impact",
  },
  "preflight-explorer-cache": {
    status: "deprecated",
    reason: "The disconnected preflight cache is not authoritative runtime state.",
  },
  "question-guard": {
    status: "deprecated",
    reason: "User clarification follows the coordinator policy without a hidden guard.",
  },
  "recovery-layer": {
    status: "deprecated",
    reason: "Live retry and recovery are enforced in the plugin governance chain.",
    replacement: "governance-wiring and loop-detector",
  },
  "run-trace": {
    status: "deprecated",
    reason: "Live observability uses audit-log and Better Harness events.",
    replacement: "audit-log",
  },
  "token-optimizer-service": {
    status: "deprecated",
    reason: "Token control uses deterministic token-budget accounting.",
    replacement: "token-budget",
  },
  workflow: {
    status: "deprecated",
    reason: "The fixed fd-task pipeline replaced the disconnected workflow service.",
    replacement: "planning-state",
  },
} as const satisfies Record<string, RuntimeFeatureContract>

/** Every top-level FlowDeckConfig key must have an explicit runtime status. */
export const CONFIG_RUNTIME_CONTRACT = {
  agentModels: { status: "wired", reason: "Consumed by resolveAgentModels and agent creation." },
  agents: { status: "wired", reason: "Supported as the legacy model override source." },
  betterHarness: { status: "wired", reason: "Consumed by the live plugin HTTP runtime." },
  designFirst: { status: "wired", reason: "Consumed by design-first config resolution and guards." },
  governance: { status: "wired", reason: "Consumed throughout the live governance chain." },
  maxDelegationDepth: { status: "wired", reason: "Consumed by the task tool guard." },
  maxWritesPerAgent: { status: "wired", reason: "Consumed by the write-limit guard." },
  runtimeAgent: { status: "wired", reason: "Consumed by runtime agent identity enforcement." },
  supervisor: { status: "wired", reason: "Consumed by supervisor-binding with legacy migration." },
} as const satisfies Record<string, RuntimeFeatureContract>
