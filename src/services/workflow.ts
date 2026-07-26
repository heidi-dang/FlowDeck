export type WorkflowClass = "trivial" | "standard" | "complex" | "ui_heavy" | "debug" | "audit"

export const WORKFLOW_CLASSES: readonly WorkflowClass[] = [
  "trivial",
  "standard",
  "complex",
  "ui_heavy",
  "debug",
  "audit",
] as const

export function isValidWorkflowClass(val: unknown): val is WorkflowClass {
  return typeof val === "string" && (WORKFLOW_CLASSES as readonly string[]).includes(val)
}

export function normalizeWorkflowClass(val: unknown): WorkflowClass {
  if (val === "quick") return "trivial"
  if (isValidWorkflowClass(val)) return val
  return "standard"
}

export function validateWorkflowClassAtStartup(val: unknown): WorkflowClass {
  if (!val) return "standard"
  if (val === "quick") return "trivial"
  if (!isValidWorkflowClass(val)) {
    throw new Error(
      `Invalid workflowClass "${val}". Supported workflow classes: ${WORKFLOW_CLASSES.join(", ")}`
    )
  }
  return val
}
