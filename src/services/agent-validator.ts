/**
 * Agent Capability Contract Validator
 *
 * Validates agent execution context against its registered contract.
 * Returns structured validation results with actionable error messages.
 *
 * Checks:
 * 1. Task type is in allowedTaskTypes
 * 2. Required inputs are present
 * 3. Tool being invoked is in allowedTools
 * 4. Output contains all expectedOutputFields (post-execution)
 * 5. No forbidden actions are being attempted
 */

import { getContract } from "./agent-contract-registry"
import { loadFlowDeckConfig } from "../config"

export type ValidatorMode = "off" | "advisory" | "strict"
export type ValidatorAction = "allow" | "warn" | "block" | "escalate"

export interface AgentExecutionContext {
  agent: string
  taskType?: string
  toolUsed?: string
  providedInputs?: Record<string, unknown>
  missingInputs?: string[]
  output?: Record<string, unknown>
  actionDescription?: string
}

export interface ValidationViolation {
  rule: string
  detail: string
  severity: "warn" | "block" | "info"
}

export interface ValidationResult {
  agent: string
  valid: boolean
  action: ValidatorAction
  violations: ValidationViolation[]
  message?: string
}

export function resolveValidatorMode(directory: string): ValidatorMode {
  try {
    const config = loadFlowDeckConfig(directory)
    const mode = config.governance?.mode ?? (config as Record<string, unknown> & { governance?: { validator?: { mode?: ValidatorMode } } })
      ?.governance?.validator?.mode
    if (mode === "off" || mode === "advisory" || mode === "strict") {
      return mode
    }
    return "advisory"
  } catch {
    return "advisory"
  }
}

/**
 * Validate an agent against its contract before or after execution.
 * In "off" mode, always returns allow.
 * In "advisory" mode, returns warn even on block-level violations.
 * In "strict" mode, returns block on block-level violations.
 */
export function validateAgent(
  directory: string,
  ctx: AgentExecutionContext,
): ValidationResult {
  const mode = resolveValidatorMode(directory)
  if (mode === "off") return { agent: ctx.agent, valid: true, action: "allow", violations: [] }

  const contract = getContract(ctx.agent)
  const violations: ValidationViolation[] = []

  if (!contract) {
    violations.push({
      rule: "no-contract",
      detail: `No capability contract registered for agent "${ctx.agent}"`,
      severity: "info",
    })
  } else {
    // Tool access check
    if (ctx.toolUsed) {
      const toolAllowed = contract.allowedTools.includes(ctx.toolUsed)
      const toolForbidden = contract.forbiddenActions.some(
        fa =>
          ctx.toolUsed!.includes(fa) ||
          fa.includes(ctx.toolUsed!) ||
          fa.split(/\s+/).some(w => w.length >= 4 && ctx.toolUsed!.toLowerCase().includes(w.toLowerCase()))
      )
      if (!toolAllowed) {
        violations.push({
          rule: "tool-not-in-contract",
          detail: `Agent "${ctx.agent}" called tool "${ctx.toolUsed}" not in allowedTools: [${contract.allowedTools.join(", ")}]`,
          severity: toolForbidden ? "block" : (mode === "strict" ? "block" : "warn"),
        })
      }
    }

    // Task type check
    if (ctx.taskType && !contract.allowedTaskTypes.includes(ctx.taskType)) {
      violations.push({
        rule: "task-type-not-allowed",
        detail: `Agent "${ctx.agent}" assigned task type "${ctx.taskType}" not in allowedTaskTypes: [${contract.allowedTaskTypes.join(", ")}]`,
        severity: "warn",
      })
    }

    // Missing required inputs
    if (ctx.missingInputs && ctx.missingInputs.length > 0) {
      violations.push({
        rule: "missing-required-inputs",
        detail: `Agent "${ctx.agent}" missing required inputs: ${ctx.missingInputs.join(", ")}`,
        severity: "warn",
      })
    }

    // Forbidden action check
    if (ctx.actionDescription) {
      for (const forbidden of contract.forbiddenActions) {
        if (ctx.actionDescription.toLowerCase().includes(forbidden.toLowerCase())) {
          violations.push({
            rule: "forbidden-action",
            detail: `Agent "${ctx.agent}" attempted forbidden action: "${forbidden}"`,
            severity: "block",
          })
        }
      }
    }

    // Output schema check
    if (ctx.output) {
      for (const expectedField of contract.expectedOutputFields) {
        if (!(expectedField in ctx.output)) {
          violations.push({
            rule: "missing-output-field",
            detail: `Agent "${ctx.agent}" output missing expected field: "${expectedField}"`,
            severity: "warn",
          })
        }
      }
    }
  }

  const hasBlocks = violations.some(v => v.severity === "block")
  const hasWarns = violations.some(v => v.severity === "warn")

  if (hasBlocks) {
    const action = mode === "strict" ? "block" : "warn"
    return {
      agent: ctx.agent,
      valid: false,
      action,
      violations,
      message: violations.map(v => `[${v.rule}] ${v.detail}`).join("; "),
    }
  }

  if (hasWarns) {
    return {
      agent: ctx.agent,
      valid: true,
      action: "warn",
      violations,
      message: violations.map(v => `[${v.rule}] ${v.detail}`).join("; "),
    }
  }

  return { agent: ctx.agent, valid: true, action: "allow", violations: [] }
}

/**
 * Quick-check helper: validate tool access for an agent.
 */
export function validateToolAccess(
  directory: string,
  agent: string,
  toolName: string,
  opts: { run_id?: string; session_id?: string } = {},
): ValidationResult {
  return validateAgent(directory, { agent, toolUsed: toolName, ...opts })
}
