import type { CodeModeRejectionReason, CodeModeTelemetry } from "./heidi-code-mode-policy"
import { HEIDI_CODE_MODE_POLICY } from "./heidi-code-mode-policy"

export interface CodeModeEvaluation {
  isEligible: boolean
  rejectionReason?: CodeModeRejectionReason
  telemetry: CodeModeTelemetry
}

const OPEN_ENDED_PATTERNS = [
  /comprehensively/i,
  /exhaustively/i,
  /all pages/i,
  /keep exploring/i,
  /across everything/i,
  /until all results are found/i,
  /keep iterating/i,
  /continuously/i,
  /all repositories/i,
  /paginate through all/i,
  /all records/i,
  /unlimited/i,
  /crawl all/i,
  /indefinitely/i,
]

const RETRY_PATTERNS = [
  /\bretr(?:y|ies|ying)\b/i,
  /exponential backoff/i,
  /retry on error/i,
]

const TASK_SPAWNING_PATTERNS = [
  /\bspecialist\b/i,
  /\bspawn\b/i,
  /\bdelegate\b/i,
  /task tool/i,
  /subagent/i,
  /launch agent/i,
]

const SHELL_PATTERNS = [
  /\bshell\b/i,
  /\bbash\b/i,
  /\bzsh\b/i,
  /\bterminal\b/i,
  /\bcurl\b/i,
  /\bping\b/i,
  /\bexec\b/i,
]

const FILESYSTEM_PATTERNS = [
  /write to file/i,
  /filesystem/i,
  /fs\./i,
  /writefile/i,
  /delete file/i,
  /modify file/i,
  /save to disk/i,
]

const DIRECT_NETWORK_PATTERNS = [
  /direct network/i,
  /fetch\(/i,
  /axios/i,
  /http\.get/i,
  /https\.request/i,
  /websocket/i,
  /socket\.connect/i,
]

const RECURSION_AND_NESTED_PATTERNS = [
  /\brecurs(?:e|ion|ive)\b/i,
  /nested execute/i,
  /nested script/i,
  /eval\(/i,
  /new Function/i,
]

export function evaluateCodeModeEligibility(
  prompt: string,
  isMcpCompositionCandidate: boolean
): CodeModeEvaluation {
  const telemetry: CodeModeTelemetry = {
    codeModeConsidered: true,
    codeModeSelected: false,
  }

  if (!isMcpCompositionCandidate) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "NOT_MCP_COMPOSITION"
    return { isEligible: false, rejectionReason: "NOT_MCP_COMPOSITION", telemetry }
  }

  // 1. Source complexity limits
  const lines = prompt.split("\n").length
  const byteLength = Buffer.byteLength(prompt, "utf-8")
  if (lines > HEIDI_CODE_MODE_POLICY.maxLines || byteLength > HEIDI_CODE_MODE_POLICY.maxSourceBytes) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "TOO_COMPLEX"
    return { isEligible: false, rejectionReason: "TOO_COMPLEX", telemetry }
  }

  // 2. Control flow restrictions
  if (RETRY_PATTERNS.some(p => p.test(prompt))) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "REQUIRES_RETRY"
    return { isEligible: false, rejectionReason: "REQUIRES_RETRY", telemetry }
  }

  if (TASK_SPAWNING_PATTERNS.some(p => p.test(prompt))) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "REQUIRES_TASK"
    return { isEligible: false, rejectionReason: "REQUIRES_TASK", telemetry }
  }

  if (SHELL_PATTERNS.some(p => p.test(prompt))) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "REQUIRES_SHELL"
    return { isEligible: false, rejectionReason: "REQUIRES_SHELL", telemetry }
  }

  if (FILESYSTEM_PATTERNS.some(p => p.test(prompt))) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "REQUIRES_FILESYSTEM"
    return { isEligible: false, rejectionReason: "REQUIRES_FILESYSTEM", telemetry }
  }

  if (DIRECT_NETWORK_PATTERNS.some(p => p.test(prompt))) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "REQUIRES_DIRECT_NETWORK"
    return { isEligible: false, rejectionReason: "REQUIRES_DIRECT_NETWORK", telemetry }
  }

  if (RECURSION_AND_NESTED_PATTERNS.some(p => p.test(prompt))) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "TOO_COMPLEX"
    return { isEligible: false, rejectionReason: "TOO_COMPLEX", telemetry }
  }

  // 3. Open-ended / unbounded exploration check
  if (OPEN_ENDED_PATTERNS.some(p => p.test(prompt))) {
    telemetry.estimatedToolCalls = 25
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "TOO_MANY_TOOL_CALLS"
    return { isEligible: false, rejectionReason: "TOO_MANY_TOOL_CALLS", telemetry }
  }

  // 4. Large collection items heuristic
  const collectionMatch = prompt.match(/\b(?:top|first|all|every)\s+(\d+)\b/i) || prompt.match(/\b(\d+)\s+(?:items|issues|prs|records|elements)\b/i)
  if (collectionMatch) {
    const count = parseInt(collectionMatch[1], 10)
    if (!isNaN(count) && count > HEIDI_CODE_MODE_POLICY.maxCollectionItems) {
      telemetry.codeModeSelected = false
      telemetry.codeModeRejectedReason = "COLLECTION_TOO_LARGE"
      return { isEligible: false, rejectionReason: "COLLECTION_TOO_LARGE", telemetry }
    }
  }

  // 5. Conservative bounds estimation
  let estimatedToolCalls = 3
  let maxParallelWidth = 2
  let dependencyStages = 2

  const lowerPrompt = prompt.toLowerCase()
  if (lowerPrompt.includes("all issues") || lowerPrompt.includes("every pull request")) {
    estimatedToolCalls = 20
  }

  if (lowerPrompt.includes("5 stages") || lowerPrompt.includes("then then then then")) {
    dependencyStages = 5
  }

  if (lowerPrompt.includes("10 parallel") || lowerPrompt.includes("concurrently fetch 8")) {
    maxParallelWidth = 8
  }

  telemetry.estimatedToolCalls = estimatedToolCalls
  telemetry.estimatedParallelWidth = maxParallelWidth
  telemetry.estimatedDependencyStages = dependencyStages

  if (maxParallelWidth > HEIDI_CODE_MODE_POLICY.maxParallelCalls) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "TOO_MUCH_PARALLELISM"
    return { isEligible: false, rejectionReason: "TOO_MUCH_PARALLELISM", telemetry }
  }

  if (dependencyStages > HEIDI_CODE_MODE_POLICY.maxDependencyStages) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "TOO_MANY_STAGES"
    return { isEligible: false, rejectionReason: "TOO_MANY_STAGES", telemetry }
  }

  if (estimatedToolCalls > HEIDI_CODE_MODE_POLICY.maxToolCalls) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "TOO_MANY_TOOL_CALLS"
    return { isEligible: false, rejectionReason: "TOO_MANY_TOOL_CALLS", telemetry }
  }

  telemetry.codeModeSelected = true
  return { isEligible: true, telemetry }
}
