import type { CodeModeRejectionReason, CodeModeTelemetry } from "./heidi-code-mode-policy"
import { HEIDI_CODE_MODE_POLICY } from "./heidi-code-mode-policy"

export interface CodeModeEvaluation {
  isEligible: boolean
  rejectionReason?: CodeModeRejectionReason
  telemetry: CodeModeTelemetry
}

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

  // Heuristic-based bounds checking
  const lowerPrompt = prompt.toLowerCase()
  
  if (lowerPrompt.includes("retry") || lowerPrompt.includes("exponential backoff")) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "REQUIRES_RETRY"
    return { isEligible: false, rejectionReason: "REQUIRES_RETRY", telemetry }
  }
  
  if (lowerPrompt.includes("specialist") || lowerPrompt.includes("spawn") || lowerPrompt.includes("delegate")) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "REQUIRES_TASK"
    return { isEligible: false, rejectionReason: "REQUIRES_TASK", telemetry }
  }
  
  if (lowerPrompt.includes("shell") || lowerPrompt.includes("bash") || lowerPrompt.includes("curl") || lowerPrompt.includes("ping") && lowerPrompt.includes("-c")) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "REQUIRES_SHELL"
    return { isEligible: false, rejectionReason: "REQUIRES_SHELL", telemetry }
  }
  
  if (lowerPrompt.includes("write to file") || lowerPrompt.includes("filesystem") || lowerPrompt.includes("fs.")) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "REQUIRES_FILESYSTEM"
    return { isEligible: false, rejectionReason: "REQUIRES_FILESYSTEM", telemetry }
  }

  // Very rudimentary heuristics for limits
  let estimatedToolCalls = 3
  let maxParallelWidth = 2
  let dependencyStages = 2

  if (lowerPrompt.includes("all issues") || lowerPrompt.includes("every pull request")) {
    estimatedToolCalls = 20
  }
  
  if (lowerPrompt.includes("continuously") || lowerPrompt.includes("keep iterating")) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "TOO_COMPLEX"
    return { isEligible: false, rejectionReason: "TOO_COMPLEX", telemetry }
  }

  telemetry.estimatedToolCalls = estimatedToolCalls
  telemetry.estimatedParallelWidth = maxParallelWidth
  telemetry.estimatedDependencyStages = dependencyStages

  if (estimatedToolCalls > HEIDI_CODE_MODE_POLICY.maxToolCalls) {
    telemetry.codeModeSelected = false
    telemetry.codeModeRejectedReason = "TOO_MANY_TOOL_CALLS"
    return { isEligible: false, rejectionReason: "TOO_MANY_TOOL_CALLS", telemetry }
  }

  telemetry.codeModeSelected = true
  return { isEligible: true, telemetry }
}
