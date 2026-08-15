import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { findWorkspaceRoot, getWorkspaceConfig, resolveActiveTopic, topicPlanPath, planningDir, readPlanningState, planningWorkspaceStatus } from "../tools/planning-state-lib"
import { RecoverableFlowDeckBlockError } from "../services/recoverable-block"
import { codebaseDir } from "../tools/codebase-state"
import { isUiHeavyTask } from "../lib/task-routing"
import { loadFlowDeckConfig, resolveDesignFirstConfig } from "../config"

const CONFIG_FILE = "config.json"
const STATE_FILE = "STATE.md"

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

// ─── Shell tokeniser and segment splitter ───────────────────────────────
//
// Parses shell syntax at the top level only — quotes, heredocs, and
// parentheses are tracked so that operators inside them are ignored.

/**
 * Strip heredoc bodies from a shell command.
 *
 * Removes everything between `<<DELIM` and a line containing only `DELIM`.
 * After stripping, all remaining content is the actual command text.
 */
export function stripHeredocBodies(cmd: string): string {
  // Match heredoc: <<'DELIM' or <<DELIM or <<-"DELIM" etc.
  return cmd.replace(
    /<<[-]?['"]?(\w+)['"]?[\s\S]*?\n\1\s*(\n|$)/g,
    (match, _delim) => {
      // Keep only the `<<DELIM` marker, drop the body and closing delimiter
      const firstLine = match.split("\n")[0]
      return firstLine + "\n"
    }
  )
}

/**
 * Split a shell command into top-level segments at `&&`, `||`, `;`, `|`, or newlines.
 *
 * Operators inside quotes, heredocs, or parentheses are NOT treated as separators.
 * Each returned segment is a single command (may be empty for trailing operators).
 */
export function splitTopLevelSegments(cmd: string): string[] {
  const segments: string[] = []
  let buf = ""
  let quote: '"' | "'" | null = null
  let parenDepth = 0
  let escaped = false

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]

    if (escaped) {
      buf += ch
      escaped = false
      continue
    }

    if (ch === "\\") {
      buf += ch
      escaped = true
      continue
    }

    if (quote) {
      buf += ch
      if (ch === quote) quote = null
      continue
    }

    if (ch === '"' || ch === "'") {
      buf += ch
      quote = ch
      continue
    }

    if (ch === "(") { parenDepth++; buf += ch; continue }
    if (ch === ")") { parenDepth = Math.max(0, parenDepth - 1); buf += ch; continue }

    // Top-level pipe
    if (ch === "|" && parenDepth === 0) {
      // Check for |& (not ||)
      if (cmd[i + 1] === "|") {
        // || is a control operator, not a pipe
        segments.push(buf.trim())
        buf = ""
        i++ // skip second |
        continue
      }
      // | at top level
      segments.push(buf.trim())
      buf = ""
      continue
    }

    // Top-level ; or &
    if ((ch === ";" || ch === "&") && parenDepth === 0) {
      if (ch === "&" && cmd[i + 1] === "&") {
        i++ // skip second &
      }
      segments.push(buf.trim())
      buf = ""
      continue
    }

    // Top-level newline
    if ((ch === "\n" || ch === "\r") && parenDepth === 0) {
      segments.push(buf.trim())
      buf = ""
      continue
    }

    buf += ch
  }

  // Last segment
  const last = buf.trim()
  if (last) segments.push(last)

  return segments.filter(s => s.length > 0)
}

/**
 * Tokenise a simplified command string (no heredocs or compound operators)
 * into whitespace-separated tokens, respecting quotes.
 */
function simpleTokenise(cmd: string): string[] {
  const tokens: string[] = []
  let buf = ""
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const ch of cmd) {
    if (escaped) { buf += ch; escaped = false; continue }
    if (ch === "\\") { escaped = true; continue }
    if (quote) {
      if (ch === quote) { quote = null; continue }
      buf += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (buf.length > 0) { tokens.push(buf); buf = "" }
      continue
    }
    buf += ch
  }
  if (buf.length > 0) tokens.push(buf)
  return tokens
}

// ─── Executable extraction and command classification ───────────────────

export interface ClassifiedCommand {
  category: "publish" | "deploy" | "build" | "local"
  executable: string
  reason: string
}

/**
 * Extract the first executable token from a command string.
 * Strips sudo, env vars, path prefixes, and shell indirection wrappers.
 */
export function extractExecutable(command: string): string {
  let s = command.trim()
  // Strip leading env vars: FOO=bar VAR=value ...
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s)) {
    const nextSpace = s.indexOf(" ", s.indexOf("="))
    if (nextSpace === -1) return ""
    s = s.slice(nextSpace + 1).trim()
  }
  // Strip sudo, nice, time etc.
  const wrapperPattern = /^(sudo|nice|time|timeout|nohup|stdbuf|env)\s+/i
  while (wrapperPattern.test(s)) {
    s = s.replace(wrapperPattern, "")
  }
  const firstWord = s.split(/[\s\t\n]+/)[0] || ""
  // Strip path prefix: /usr/bin/node → node, ./scripts/deploy.sh → deploy.sh
  return firstWord.split("/").pop() || ""
}

/**
 * Convert a relative/absolute script path to its base name for classification.
 * e.g., ./scripts/deploy.sh → deploy.sh, /usr/local/bin/custom-deploy → custom-deploy
 */
function baseName(path: string): string {
  return path.split("/").pop() || path
}

/**
 * Classify a SINGLE command segment by its first executable token.
 * This is the core classification logic.
 */
function classifySegment(segment: string): ClassifiedCommand {
  const executable = extractExecutable(segment)
  if (!executable) {
    return { category: "local", executable, reason: "empty or unrecognised executable" }
  }

  const exe = executable.toLowerCase()
  // Detect script invocations for classification
  const scriptName = baseName(executable).toLowerCase()
  const fullLine = segment.trim()

  // ── SHELL INDIRECTION: classify what bash/sh/dash runs ────────────
  if (["bash", "sh", "dash", "ksh", "zsh"].includes(exe)) {
    // bash script.sh → classify the script
    const tokens = simpleTokenise(fullLine)
    // Find the first non-flag argument (the script)
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i]
      if (t === "-c") {
        // bash -c "inline command" → classify the inline command
        const inlineStart = fullLine.indexOf(t) + t.length
        const inlineCmd = fullLine.slice(inlineStart).trim().replace(/^["']|["']$/g, "")
        if (inlineCmd) return classifySegment(inlineCmd)
        break
      }
      if (t.startsWith("-")) continue
      // This is a script path
      return classifySegment(t)
    }
    return { category: "local", executable: exe, reason: `${exe} shell` }
  }

  // ── SCRIPT PATHS: ./deploy.sh, scripts/deploy.sh, path/to/script ──
  // Also matches bare script names like deploy.sh, publish.sh when they
  // are the first argument passed to a shell wrapper (bash/sh/dash).
  if (exe.includes(".") && !exe.includes(" ") && (
    fullLine.startsWith("./") || fullLine.startsWith("/") || executable.includes("/") ||
    /\.(sh|py|js|bash|pl|rb)$/i.test(exe)
  )) {
    if (/deploy/i.test(scriptName)) {
      return { category: "deploy", executable: exe, reason: `deploy script: ${baseName(executable)}` }
    }
    if (/publish/i.test(scriptName)) {
      return { category: "publish", executable: exe, reason: `publish script: ${baseName(executable)}` }
    }
    if (/build/i.test(scriptName)) {
      return { category: "build", executable: exe, reason: `build script: ${baseName(executable)}` }
    }
  }

  // ── PUBLISH: registry upload — requires /fd-task approval ─────────
  if (exe === "npm" && /\bnpm\s+(publish|unpublish)\b/i.test(fullLine)) {
    return { category: "publish", executable: exe, reason: "npm publish" }
  }
  if (exe === "bun" && /\bbun\s+(publish|unpublish)\b/i.test(fullLine)) {
    return { category: "publish", executable: exe, reason: "bun publish" }
  }
  if (exe === "cargo" && /\bcargo\s+publish\b/i.test(fullLine)) {
    return { category: "publish", executable: exe, reason: "cargo publish" }
  }
  if (exe === "pnpm" && /\bpnpm\s+(publish|unpublish)\b/i.test(fullLine)) {
    return { category: "publish", executable: exe, reason: "pnpm publish" }
  }
  if (exe === "yarn" && /\byarn\s+(publish|unpublish)\b/i.test(fullLine)) {
    return { category: "publish", executable: exe, reason: "yarn publish" }
  }
  if (exe === "twine" && /\btwine\s+upload\b/i.test(fullLine)) {
    return { category: "publish", executable: exe, reason: "twine upload" }
  }
  if (exe === "gem" && /\bgem\s+push\b/i.test(fullLine)) {
    return { category: "publish", executable: exe, reason: "gem push" }
  }

  // ── DEPLOY: production infrastructure — requires /fd-task approval ─
  if (exe === "docker") {
    if (/\bdocker\s+(push|deploy|stack)\b/i.test(fullLine)) {
      return { category: "deploy", executable: exe, reason: "docker push/deploy" }
    }
    if (/\bdocker(\s+compose)?\s+up\b/i.test(fullLine)) {
      return { category: "deploy", executable: exe, reason: "docker compose up" }
    }
  }
  if (exe === "kubectl" && /\bkubectl\s+(apply|set|create|patch|replace|rollout)\b/i.test(fullLine)) {
    return { category: "deploy", executable: exe, reason: "kubectl mutate" }
  }
  if (exe === "helm" && /\bhelm\s+(upgrade|install|rollback)\b/i.test(fullLine)) {
    return { category: "deploy", executable: exe, reason: "helm upgrade/install" }
  }
  if (exe === "terraform" && /\bterraform\s+apply\b/i.test(fullLine)) {
    return { category: "deploy", executable: exe, reason: "terraform apply" }
  }
  if (exe === "tofu" && /\btofu\s+apply\b/i.test(fullLine)) {
    return { category: "deploy", executable: exe, reason: "tofu apply" }
  }
  if (exe === "pulumi" && /\bpulumi\s+up\b/i.test(fullLine)) {
    return { category: "deploy", executable: exe, reason: "pulumi up" }
  }
  if (exe === "gh" && /\bgh\s+release\s+create\b/i.test(fullLine)) {
    return { category: "deploy", executable: exe, reason: "gh release create" }
  }
  if (exe === "vercel" && /\bvercel\s+--prod\b/i.test(fullLine)) {
    return { category: "deploy", executable: exe, reason: "vercel --prod" }
  }
  if ((exe === "serverless" || exe === "sls") && /\bsls?\s+deploy\b/i.test(fullLine)) {
    return { category: "deploy", executable: exe, reason: "serverless deploy" }
  }
  if (exe === "netlify" && /\bnetlify\s+deploy\b/i.test(fullLine)) {
    return { category: "deploy", executable: exe, reason: "netlify deploy" }
  }
  if (exe === "gcloud" && /\bgcloud\s+(app\s+deploy|run\s+deploy|functions\s+deploy)\b/i.test(fullLine)) {
    return { category: "deploy", executable: exe, reason: "gcloud deploy" }
  }
  if (exe === "aws") {
    if (/\baws\s+(s3\s+sync|lambda\s+update|ecs\s+update|deploy)\b/i.test(fullLine)) {
      return { category: "deploy", executable: exe, reason: "aws deploy" }
    }
  }

  // ── BUILD: compile/package (informational, no approval) ──────────
  if (exe === "npm" && /\bnpm\s+(run\s+)?build\b/i.test(fullLine)) {
    return { category: "build", executable: exe, reason: "npm build" }
  }
  if (exe === "bun" && /\bbun\s+(run\s+)?build\b/i.test(fullLine)) {
    return { category: "build", executable: exe, reason: "bun build" }
  }
  if (exe === "yarn" && /\byarn\s+(run\s+)?build\b/i.test(fullLine)) {
    return { category: "build", executable: exe, reason: "yarn build" }
  }
  if (exe === "pnpm" && /\bpnpm\s+(run\s+)?build\b/i.test(fullLine)) {
    return { category: "build", executable: exe, reason: "pnpm build" }
  }
  if (exe === "make") {
    return { category: "build", executable: exe, reason: "make" }
  }
  if (exe === "cargo" && /\bcargo\s+build\b/i.test(fullLine)) {
    return { category: "build", executable: exe, reason: "cargo build" }
  }
  if (exe === "gradle" || exe === "gradlew") {
    return { category: "build", executable: exe, reason: "gradle" }
  }
  if (exe === "mvn" && /\bmvn\s+(package|install|compile|verify)\b/i.test(fullLine)) {
    return { category: "build", executable: exe, reason: "maven build" }
  }

  // ── Install/run (local operations, no approval) ──────────────────
  if (exe === "npm" && /\bnpm\s+(install|ci|run)\b/i.test(fullLine) && !/\bnpm\s+publish\b/i.test(fullLine)) {
    return { category: "local", executable: exe, reason: "npm install/ci/run" }
  }
  if (exe === "bun" && /\bbun\s+(install|add|run)\b/i.test(fullLine) && !/\bbun\s+publish\b/i.test(fullLine)) {
    return { category: "local", executable: exe, reason: "bun install/add/run" }
  }
  if (exe === "pip" && /\bpip\s+install\b/i.test(fullLine)) {
    return { category: "local", executable: exe, reason: "pip install" }
  }
  if (exe === "docker" && /\bdocker\s+(build|run|exec)\b/i.test(fullLine)) {
    return { category: "local", executable: exe, reason: "docker build/run/exec" }
  }
  if (exe === "git" && /\bgit\s+push\b/i.test(fullLine)) {
    return { category: "local", executable: exe, reason: "git push" }
  }

  // ── EVERYTHING ELSE is local scripting ──────────────────────────
  return { category: "local", executable: exe, reason: `${exe} is a local operation` }
}

/**
 * Classify a complete command (may contain compound operators).
 *
 * Pipeline:
 *   1. Strip heredoc bodies
 *   2. Split into top-level segments on &&, ||, ;, |, newline
 *   3. Classify each segment independently
 *   4. Return the highest-risk category found (publish > deploy > build > local)
 */
export function classifyCommand(command: string): ClassifiedCommand & { segments?: ClassifiedCommand[] } {
  if (!command || !command.trim()) {
    return { category: "local", executable: "", reason: "empty command" }
  }

  // Step 1: Strip heredoc bodies to prevent false positives
  const stripped = stripHeredocBodies(command)

  // Step 2: Split into top-level segments
  const segments = splitTopLevelSegments(stripped)
  if (segments.length === 0) {
    return { category: "local", executable: "", reason: "no executable segments found" }
  }

  // Step 3: Classify each segment
  const results: ClassifiedCommand[] = segments.map(s => {
    // Skip empty or whitespace-only segments
    if (!s.trim()) return null
    const trimmed = s.trim()
    // Skip heredoc closers that may remain
    if (/^\w+$/.test(trimmed) && trimmed.length < 20) {
      // could be a heredoc delimiter re-appearing, be conservative
    }
    const result = classifySegment(trimmed)
    // Attach the segment for diagnostics
    return { ...result, _segment: trimmed.slice(0, 120) }
  }).filter(Boolean) as ClassifiedCommand[]

  if (results.length === 0) {
    return { category: "local", executable: "", reason: "no classifiable segments" }
  }

  // Step 4: Return highest-risk category
  // Priority: publish > deploy > build > local
  const firstExe = results[0].executable
  const firstReason = results[0].reason

  for (const r of results) {
    if (r.category === "publish") {
      return { category: "publish", executable: r.executable, reason: r.reason, segments: results }
    }
  }
  for (const r of results) {
    if (r.category === "deploy") {
      return { category: "deploy", executable: r.executable, reason: r.reason, segments: results }
    }
  }
  for (const r of results) {
    if (r.category === "build") {
      return { category: "build", executable: r.executable, reason: r.reason, segments: results }
    }
  }

  return { category: "local", executable: firstExe, reason: firstReason, segments: results }
}

export type Severity = "warn" | "block" | null

const isEnabled = (): boolean => process.env.FLOWDECK_GUARD_RAILS_ENABLED !== "off"

/**
 * HOOK-03: Guard rails enforcement
 * Uses executable-based classification with compound-command parsing.
 */
export async function guardRailsHook(
  ctx: { directory: string },
  input: { tool: string },
  _output: any
): Promise<void> {
  if (!isEnabled()) return

  const dir = ctx.directory
  const planningDirPath = planningDir(dir)
  const _codebaseDirectory = codebaseDir(dir)
  const configPath = join(planningDirPath, CONFIG_FILE)
  const statePath = join(planningDirPath, STATE_FILE)

  const workspaceRoot = findWorkspaceRoot(dir)
  if (workspaceRoot && dir !== workspaceRoot) {
    const config = getWorkspaceConfig(dir)
    if (config && config.workspace_mode === "shared" && !existsSync(planningDirPath)) {
      throw new Error(`[flowdeck] BLOCK: No planning workspace for this sub-repo. Switch to workspace root: cd ${workspaceRoot}`)
    }
  }

  if (input.tool === "write" || input.tool === "edit" || input.tool === "write_file" || input.tool === "edit_file" || input.tool === "patch" || input.tool === "apply_patch") {
    const status = planningWorkspaceStatus(dir)
    if (status === "absent" || status === "incomplete_orphaned" || status === "valid_no_active_plan") return
    if (existsSync(join(planningDirPath, ".fd-task-lock"))) return

    const execMode = resolveExecutionMode(configPath, null)
    if (execMode === "review-only") {
      throw new RecoverableFlowDeckBlockError({
        subsystem: "guard_rails",
        code: "REVIEW_ONLY_MODE",
        tool: input.tool,
        reason: "Review-only mode enabled: propose diffs without applying file writes.",
        recoverable: true,
        suggestedActions: ["Propose the code diff in conversation", "Change execution_mode in config.json"],
      })
    }

    const designGateMessage = getDesignGateMessage(dir)
    if (designGateMessage) {
      throw new RecoverableFlowDeckBlockError({
        subsystem: "guard_rails",
        code: "DESIGN_GATE_BLOCKED",
        tool: input.tool,
        reason: designGateMessage,
        recoverable: true,
        suggestedActions: ["Approve UI design handoff", "Add design_override in planning state"],
      })
    }

    if (status === "active_unconfirmed") {
      const severity = effectiveSeverity(configPath, statePath)
      if (severity === "block") {
        throw new RecoverableFlowDeckBlockError({
          subsystem: "guard_rails",
          code: "PLAN_NOT_CONFIRMED",
          tool: input.tool,
          reason: "Active plan is not confirmed yet. Please confirm the plan before editing.",
          recoverable: true,
          suggestedActions: ["Confirm the plan via planning-state tool", "Ask the user to confirm the plan"],
        })
      }
    }
  }

  // Guard bash build/deploy/publish commands
  if (input.tool === "bash") {
    const cmd = (_output as any)?.args?.command || ""
    if (!cmd.trim()) return

    const classified = classifyCommand(cmd)

    if (classified.category === "publish" || classified.category === "deploy") {
      if (!getPlanConfirmed(statePath)) {
        const diagnostics = classified.segments
          ?.map(s => `  Segment: ${s.executable} → ${s.category}: ${s.reason}`)
          .join("\n") ?? ""
        throw new Error(
          `[flowdeck] WARNING: Build/deploy command detected but plan is not confirmed. Run /fd-task first.\n` +
          `  Category: ${classified.category}\n` +
          `  Executable: ${classified.executable}\n` +
          `  Reason: ${classified.reason}\n` +
          diagnostics
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
      return "[flowdeck] WARNING: UI-heavy task detected without approved design handoff."
    }
    return "[flowdeck] BLOCK: UI-heavy task requires approved design handoff."
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



export function getPlanConfirmed(statePath: string): boolean {
  if (!existsSync(statePath)) return false
  try {
    const content = readFileSync(statePath, "utf-8")
    const match = content.match(/plan_confirmed:\s*(true|false)/i)
    return match ? match[1].toLowerCase() === "true" : false
  } catch { return false }
}
