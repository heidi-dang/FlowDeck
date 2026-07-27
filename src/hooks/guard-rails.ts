import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { findWorkspaceRoot, getWorkspaceConfig, resolveActiveTopic, topicPlanPath, planningDir, readPlanningState } from "../tools/planning-state-lib"
import { codebaseDir } from "../tools/codebase-state"
import { isUiHeavyTask } from "../lib/task-routing"
import { loadFlowDeckConfig, resolveDesignFirstConfig } from "../config"

const CONFIG_FILE = "config.json"
const STATE_FILE = "STATE.md"

/**
 * Safe Execution Mode — three tiers of AI edit safety.
 */
export type ExecutionMode = "auto" | "guarded" | "review-only"

export function resolveExecutionMode(
  configPath: string,
  trustScore: number | null,
  volatility?: string
): ExecutionMode {
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"))
      if (config.execution_mode === "review-only") return "review-only"
      if (config.execution_mode === "guarded") return "guarded"
      if (config.execution_mode === "auto") return "auto"
    } catch { /* fall through */ }
  }
  if (trustScore !== null) {
    if (trustScore < 30) return "review-only"
    if (trustScore < 60) return "guarded"
  }
  if (volatility === "critical") return "review-only"
  if (volatility === "volatile") return "guarded"
  return "auto"
}

// ─── Build/Deploy/Publish command detection ─────────────────────────────
//
// Classification is based on the first executable token of the command,
// NOT substring matching. This prevents false positives from heredocs
// (e.g., python3 <<'PYEOF' containing "npm publish"), arguments, or file content.
//
// Categories:
//   - publish:   Uploads a package to a registry (requires /fd-task approval)
//   - deploy:    Pushes to production infrastructure (requires /fd-task approval)
//   - build:     Compiles/packages artifacts (informational, may skip approval)
//   - local:     Scripting, file ops, analysis (never requires approval)

export interface ClassifiedCommand {
  category: "publish" | "deploy" | "build" | "local"
  executable: string
  reason: string
}

/**
 * Parse the first executable token from a shell command string.
 * Strips sudo, env vars, and path components to get the raw executable name.
 */
export function extractExecutable(command: string): string {
  let s = command.trim()
  // Strip leading env vars: FOO=bar VAR=value ...
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) {
    const nextEq = s.indexOf("=")
    const nextSpace = s.indexOf(" ", nextEq)
    if (nextSpace === -1) return ""
    s = s.slice(nextSpace + 1).trim()
  }
  // Strip sudo, nice, time etc.
  const wrapperPattern = /^(sudo|nice|time|timeout|nohup|stdbuf|env)\s+/i
  while (wrapperPattern.test(s)) {
    s = s.replace(wrapperPattern, "")
  }
  // Get first word (the executable)
  const firstWord = s.split(/[\s\t\n]+/)[0] || ""
  // Strip path prefix: /usr/bin/node → node
  return firstWord.split("/").pop() || ""
}

/**
 * Classify a command by its first executable token.
 * Returns { category, executable, reason }.
 */
export function classifyCommand(command: string): ClassifiedCommand {
  const executable = extractExecutable(command)
  if (!executable) {
    return { category: "local", executable, reason: "empty or unrecognised executable" }
  }

  const exe = executable.toLowerCase()

  // ── PUBLISH: registry upload — requires approval ───────────────────
  if (exe === "npm" && /\bnpm\s+(publish|unpublish)\b/i.test(command)) {
    return { category: "publish", executable: exe, reason: "npm publish" }
  }
  if (exe === "bun" && /\bbun\s+(publish|unpublish)\b/i.test(command)) {
    return { category: "publish", executable: exe, reason: "bun publish" }
  }
  if (exe === "cargo" && /\bcargo\s+publish\b/i.test(command)) {
    return { category: "publish", executable: exe, reason: "cargo publish" }
  }
  if (exe === "pnpm" && /\bpnpm\s+(publish|unpublish)\b/i.test(command)) {
    return { category: "publish", executable: exe, reason: "pnpm publish" }
  }
  if (exe === "yarn" && /\byarn\s+(publish|unpublish)\b/i.test(command)) {
    return { category: "publish", executable: exe, reason: "yarn publish" }
  }
  if (exe === "twine" && /\btwine\s+upload\b/i.test(command)) {
    return { category: "publish", executable: exe, reason: "twine upload" }
  }
  if (exe === "gem" && /\bgem\s+push\b/i.test(command)) {
    return { category: "publish", executable: exe, reason: "gem push" }
  }
  if (exe === "publish" || /\b(publish|dist-tag)\b/i.test(command)) {
    // Generic publish command — only flag when the tool is publish-related
    if (["npm", "bun", "cargo", "pnpm", "yarn", "twine", "gem", "docker"].includes(exe)) {
      return { category: "publish", executable: exe, reason: `publish command: ${exe}` }
    }
  }

  // ── DEPLOY: production infrastructure — requires approval ──────────
  if (exe === "docker" && /\bdocker\s+(push|deploy|stack)\b/i.test(command)) {
    return { category: "deploy", executable: exe, reason: "docker push/deploy" }
  }
  if (exe === "kubectl" && /\bkubectl\s+(apply|set|create|patch|replace|rollout)\b/i.test(command)) {
    return { category: "deploy", executable: exe, reason: "kubectl mutate" }
  }
  if (exe === "helm" && /\bhelm\s+(upgrade|install|rollback)\b/i.test(command)) {
    return { category: "deploy", executable: exe, reason: "helm upgrade/install" }
  }
  if (exe === "terraform" && /\bterraform\s+apply\b/i.test(command)) {
    return { category: "deploy", executable: exe, reason: "terraform apply" }
  }
  if (exe === "tofu" && /\btofu\s+apply\b/i.test(command)) {
    return { category: "deploy", executable: exe, reason: "tofu apply" }
  }
  if (exe === "pulumi" && /\bpulumi\s+up\b/i.test(command)) {
    return { category: "deploy", executable: exe, reason: "pulumi up" }
  }
  if (exe === "gh" && /\bgh\s+release\s+create\b/i.test(command)) {
    return { category: "deploy", executable: exe, reason: "gh release create" }
  }
  if (exe === "vercel" && /\bvercel\s+--prod\b/i.test(command)) {
    return { category: "deploy", executable: exe, reason: "vercel --prod" }
  }
  if (exe === "serverless" || exe === "sls") {
    if (/\b(serverless|sls)\s+deploy\b/i.test(command)) {
      return { category: "deploy", executable: exe, reason: "serverless deploy" }
    }
  }
  if (exe === "netlify" && /\bnetlify\s+deploy\b/i.test(command)) {
    return { category: "deploy", executable: exe, reason: "netlify deploy" }
  }
  if (exe === "gcloud" && /\bgcloud\s+(app\s+deploy|run\s+deploy|functions\s+deploy)\b/i.test(command)) {
    return { category: "deploy", executable: exe, reason: "gcloud deploy" }
  }
  if (exe === "aws") {
    if (/\baws\s+(s3\s+sync|lambda\s+update|ecs\s+update|deploy)\b/i.test(command)) {
      return { category: "deploy", executable: exe, reason: "aws deploy" }
    }
  }

  // ── BUILD: compile/package (informational, no approval needed) ────
  if (exe === "npm" && /\bnpm\s+(run\s+)?build\b/i.test(command)) {
    return { category: "build", executable: exe, reason: "npm build" }
  }
  if (exe === "bun" && /\bbun\s+(run\s+)?build\b/i.test(command)) {
    return { category: "build", executable: exe, reason: "bun build" }
  }
  if (exe === "yarn" && /\byarn\s+(run\s+)?build\b/i.test(command)) {
    return { category: "build", executable: exe, reason: "yarn build" }
  }
  if (exe === "pnpm" && /\bpnpm\s+(run\s+)?build\b/i.test(command)) {
    return { category: "build", executable: exe, reason: "pnpm build" }
  }
  if (exe === "make" && /\bmake\s+/i.test(command)) {
    return { category: "build", executable: exe, reason: "make" }
  }
  if (exe === "cargo" && /\bcargo\s+build\b/i.test(command)) {
    return { category: "build", executable: exe, reason: "cargo build" }
  }
  if (exe === "gradle" || exe === "gradlew") {
    return { category: "build", executable: exe, reason: "gradle" }
  }
  if (exe === "mvn" && /\bmvn\s+(package|install|compile|verify)\b/i.test(command)) {
    return { category: "build", executable: exe, reason: "maven build" }
  }

  // ── Install commands (not publish — can run without approval) ─────
  if (exe === "npm" && /\bnpm\s+(install|ci|run)\b/i.test(command) && !/\bnpm\s+publish\b/i.test(command)) {
    return { category: "local", executable: exe, reason: "npm install/ci/run" }
  }
  if (exe === "bun" && /\bbun\s+(install|add|run)\b/i.test(command) && !/\bbun\s+publish\b/i.test(command)) {
    return { category: "local", executable: exe, reason: "bun install/add/run" }
  }
  if (exe === "pip" && /\bpip\s+install\b/i.test(command)) {
    return { category: "local", executable: exe, reason: "pip install" }
  }
  if (exe === "docker" && /\bdocker\s+(build|run)\b/i.test(command)) {
    // docker build/run are local operations, not deployment
    return { category: "local", executable: exe, reason: "docker build/run" }
  }
  if (exe === "git" && /\bgit\s+push\b/i.test(command)) {
    // git push is source control, not deployment
    return { category: "local", executable: exe, reason: "git push" }
  }

  // ── EVERYTHING ELSE is local scripting — never requires approval ──
  return { category: "local", executable: exe, reason: `${exe} is a local operation` }
}

export type Severity = "warn" | "block" | null

/**
 * HOOK-03: Guard rails enforcement
 * Blocks write/edit tools when plan is not confirmed (plan_confirmed=false).
 * Allows write/edit tools when plan is confirmed (plan_confirmed=true).
 * Detects bash build/deploy/publish commands using executable-based classification.
 * Respects guard_enforcement override in config.json.
 */
const isEnabled = (): boolean => process.env.FLOWDECK_GUARD_RAILS_ENABLED !== "off"

export async function guardRailsHook(
  ctx: { directory: string },
  input: { tool: string },
  _output: any
): Promise<void> {
  if (!isEnabled()) return

  const dir = ctx.directory
  const planningDirPath = planningDir(dir)
  const codebaseDirectory = codebaseDir(dir)
  const configPath = join(planningDirPath, CONFIG_FILE)
  const statePath = join(planningDirPath, STATE_FILE)

  // HOOK-WS-02: Workspace-aware blocking for shared mode
  const workspaceRoot = findWorkspaceRoot(dir)
  if (workspaceRoot && dir !== workspaceRoot) {
    const config = getWorkspaceConfig(dir)
    if (config && config.workspace_mode === "shared" && !existsSync(planningDirPath)) {
      const msg = `No planning workspace for this sub-repo. Switch to workspace root: cd ${workspaceRoot}`
      throw new Error(`[flowdeck] BLOCK: ${msg}`)
    }
  }

  // Guard write/edit tools — only applies to FlowDeck-initialized projects
  if (input.tool === "write" || input.tool === "edit") {
    if (!existsSync(planningDirPath)) return
    if (!existsSync(codebaseDirectory)) {
      throw new Error(`[flowdeck] WARNING: .codebase/ not found. Run /fd-task — its init step maps the codebase.`)
    }

    const execMode = resolveExecutionMode(configPath, null)
    if (execMode === "review-only") {
      throw new Error(`[flowdeck] BLOCK (review-only mode): propose diff but do not apply. Set execution_mode in ${configPath} to change.`)
    }
    if (execMode === "guarded") {
      throw new Error(`[flowdeck] GUARDED MODE: edit will proceed but flag for human review.`)
    }

    const designGateMessage = getDesignGateMessage(dir)
    if (designGateMessage) {
      throw new Error(designGateMessage)
    }

    const effectiveSeverity = getEffectiveSeverity(configPath, statePath)
    if (effectiveSeverity === null) return

    if (effectiveSeverity === "warn") {
      const warning = getWarningMessage(planningDirPath)
      throw new Error(`[flowdeck] WARNING: ${warning}`)
    }

    const blockMessage = getBlockMessage(planningDirPath)
    throw new Error(`[flowdeck] BLOCK: ${blockMessage}`)
  }

  // Guard bash build/deploy/publish commands (proposal spec line 416)
  if (input.tool === "bash") {
    const cmd = (_output as any)?.args?.command || ""
    if (!cmd.trim()) return

    const classified = classifyCommand(cmd)

    // Only publish and deploy commands require /fd-task approval.
    // Build and local commands pass through without approval.
    if (classified.category === "publish" || classified.category === "deploy") {
      if (!getPlanConfirmed(statePath)) {
        throw new Error(
          `[flowdeck] WARNING: Build/deploy command detected but plan is not confirmed. Run /fd-task first.\n` +
          `  Category: ${classified.category}\n` +
          `  Executable: ${classified.executable}\n` +
          `  Reason: ${classified.reason}`
        )
      }
    }
  }
}

function getDesignGateMessage(dir: string): string | null {
  const designConfig = resolveDesignFirstConfig(loadFlowDeckConfig(dir))
  if (!designConfig.enabled || !designConfig.requireApprovalBeforeImplementation) return null
  const state = readPlanningState(dir)
  if (state.design_override && state.design_override_reason && state.design_override_reason.trim().length > 0) return null

  const designApproved = state.design_stage === "handoff_complete" && state.design_approved
  if (state.requires_design_first || (state.task_type && isUiHeavyTask(state.task_type)) || planSuggestsUiHeavy(dir, state)) {
    if (designApproved) return null
    if (designConfig.enforcement === "advisory") {
      return "[flowdeck] WARNING: UI-heavy task detected without approved design handoff. Capture the design in architecture.md via /fd-task, then approve it in /fd-review."
    }
    return "[flowdeck] BLOCK: UI-heavy task requires approved design handoff. Capture the design in architecture.md via /fd-task and approve it in /fd-review, or set explicit design override in STATE.md."
  }
  return null
}

function planSuggestsUiHeavy(dir: string, state: { topic?: string }): boolean {
  const topic = resolveActiveTopic(dir, state)
  if (!topic) return false
  const planPath = topicPlanPath(dir, topic)
  if (!existsSync(planPath)) return false
  const planContent = readFileSync(planPath, "utf-8")
  return isUiHeavyTask(planContent)
}

/**
 * Determine effective severity based on config.json override or STATE.md plan_confirmed.
 */
export function effectiveSeverity(configPath: string, statePath: string): Severity {
  if (existsSync(configPath)) {
    try {
      const configContent = readFileSync(configPath, "utf-8")
      const config = JSON.parse(configContent)
      if (config.guard_enforcement === "warn") return "warn"
      if (config.guard_enforcement === "block") return "block"
      if (config.guard_enforcement === "off") return null
    } catch { /* fall through */ }
  }
  return getPlanConfirmed(statePath) ? null : "block"
}

function getEffectiveSeverity(configPath: string, statePath: string): Severity {
  return effectiveSeverity(configPath, statePath)
}

export function getPlanConfirmed(statePath: string): boolean {
  if (!existsSync(statePath)) return false
  try {
    const content = readFileSync(statePath, "utf-8")
    const match = content.match(/plan_confirmed:\s*(true|false)/i)
    return match ? match[1].toLowerCase() === "true" : false
  } catch {
    return false
  }
}

function getWarningMessage(planningDir: string): string {
  if (!existsSync(join(planningDir, STATE_FILE))) {
    return "No STATE.md found. Run /fd-task to initialize the workspace and plan the task."
  }
  return "Guard enforcement is set to 'warn'. Plan is not confirmed. Run /fd-task and confirm the plan to enable execution."
}

function getBlockMessage(planningDir: string): string {
  if (!existsSync(join(planningDir, STATE_FILE))) {
    return "No STATE.md found. Run /fd-task to initialize the workspace and plan the task."
  }
  return "Plan not confirmed. Run /fd-task and confirm the plan to enable execution."
}
