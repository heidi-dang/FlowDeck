export const HEIDI_CODE_MODE_POLICY = {
  // Source complexity
  maxLines: 80,
  maxSourceBytes: 12_288, // 12 KiB
  // Tool orchestration
  maxToolCalls: 10,
  maxParallelCalls: 4,
  maxDependencyStages: 3,
  maxCollectionItems: 25,
  // Execution
  timeoutMs: 30_000,
  maxOutputBytes: 65_536, // 64 KiB
  // Recovery/control flow
  maxRetries: 0,
  allowRecursion: false,
  allowNestedExecute: false,
  allowAgentSpawning: false,
  // Ambient authority
  allowImports: false,
  allowDynamicCode: false,
  allowFilesystem: false,
  allowShell: false,
  allowDirectNetwork: false,
  allowEnvironment: false,
}

export type CodeModeCapability = "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN"

export type CodeModeRejectionReason =
  | "NOT_MCP_COMPOSITION"
  | "EXECUTE_UNAVAILABLE"
  | "TOO_MANY_TOOL_CALLS"
  | "TOO_MUCH_PARALLELISM"
  | "TOO_MANY_STAGES"
  | "COLLECTION_TOO_LARGE"
  | "EXPECTED_TIMEOUT"
  | "REQUIRES_RETRY"
  | "REQUIRES_TASK"
  | "REQUIRES_SHELL"
  | "REQUIRES_FILESYSTEM"
  | "REQUIRES_DIRECT_NETWORK"
  | "TOO_COMPLEX"

export interface CodeModeTelemetry {
  codeModeConsidered: boolean
  codeModeSelected: boolean
  codeModeRejectedReason?: CodeModeRejectionReason
  estimatedToolCalls?: number
  estimatedParallelWidth?: number
  estimatedDependencyStages?: number
  actualToolCalls?: number
  actualDurationMs?: number
  actualResultBytes?: number
  terminalStatus?: "success" | "error" | "timeout"
}
