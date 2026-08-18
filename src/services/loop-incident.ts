/**
 * LoopIncident — incident-based loop steering for FlowDeck.
 *
 * Redesigns loop detection away from "count repeated executions and block with
 * a big UI error" toward incident-based steering:
 *
 *   real repeated no-progress action
 *     -> LOOP INCIDENT OPEN
 *     -> action fingerprint suppressed (does NOT execute, does NOT increment
 *        the real executed-repeat count, does NOT create another large UI block,
 *        does NOT restart routing, does NOT ask the human)
 *     -> automatic recovery directive (one compact machine-actionable redirect)
 *     -> Heidi uses a materially different operation / gains new information
 *     -> incident resolved
 *
 * Requirements D + E + U:
 *   - Blocked attempts never count as executed repeats.
 *   - Rich fingerprints: same request === same fingerprint; different ranges,
 *     offsets, symbols, queries, scopes remain distinct (no false positives).
 *   - A recoverable block returns an immediate executable redirect with
 *     humanInputRequired: false whenever a safe autonomous alternative exists.
 */

export interface LoopIncidentState {
  incidentId: string
  sessionID: string
  fingerprint: string
  blockedCount: number
  executedRepeatCount: number
  openedAt: number
  lastBlockedAt: number
  lastRecoveryDirective?: RecoveryRedirect
  status: "OPEN" | "RESOLVED"
}

export interface RecoveryRedirect {
  directive: "FLOWDECK_RECOVERY_REDIRECT"
  blockedFingerprint: string
  reason: string
  doNotRetry: string
  continueImmediatelyWith: string[]
  humanInputRequired: false
}

export interface FingerprintOptions {
  file?: string
  path?: string
  offset?: number | string
  limit?: number | string
  symbol?: string
  mode?: string
  query?: string
  scope?: string
  [k: string]: unknown
}

const READ_TOOL_KEYS = ["file", "path", "filePath", "offset", "limit", "symbol", "mode", "query", "scope", "symbolName", "name"]
const SEARCH_TOOL_KEYS = ["query", "pattern", "path", "scope", "include", "files", "directory"]

/**
 * Deterministic, semantically meaningful fingerprint for a tool action.
 * Distinguishes different ranges, symbols, queries and scopes while keeping
 * an identical request identical. Never collapses a whole repo/path set into
 * one false-positive key.
 */
export function fingerprintAction(toolName: string, args: Record<string, unknown>): string {
  const tool = String(toolName).toLowerCase()
  const normArgs: FingerprintOptions = {}

  // Bash/shell: fingerprint the exact normalized command.
  if (tool === "bash" || tool === "shell" || tool === "exec") {
    const raw = (args.command as string) ?? (args.cmd as string) ?? ""
    return `shell:${normalizeCommand(raw)}`
  }

  // Read/view tools: preserve content-range and selector arguments.
  if (tool === "read" || tool === "read_file" || tool === "view" || tool === "fdx-read") {
    for (const k of READ_TOOL_KEYS) {
      if (args[k] !== undefined) normArgs[k] = args[k]
    }
    const fileKey = (normArgs.file ?? normArgs.filePath ?? normArgs.path ?? "").toString()
    return `read:${fileKey}` + `|o=${normArgs.offset ?? 0}|l=${normArgs.limit ?? ""}` + `|s=${normArgs.symbol ?? ""}`
  }

  // Search/grep tools: preserve the search pattern + scope + path.
  if (tool === "grep" || tool === "glob" || tool === "search" || tool === "fdx-grep" || tool === "fdx-search") {
    for (const k of SEARCH_TOOL_KEYS) {
      if (args[k] !== undefined) normArgs[k] = args[k]
    }
    const q = (normArgs.query ?? normArgs.pattern ?? "").toString()
    const p = (normArgs.path ?? normArgs.directory ?? "").toString()
    const sc = (normArgs.scope ?? normArgs.include ?? "").toString()
    return `search:${q}|path=${p}|scope=${sc}`
  }

  // Outline/impact: keep symbols and paths.
  if (tool === "outline" || tool === "fdx-outline") {
    const f = (args.path as string) ?? (args.file as string) ?? ""
    const sy = (args.symbol as string) ?? ""
    return `outline:${f}|s=${sy}`
  }
  if (tool === "impact" || tool === "fdx-impact") {
    const f = (args.path as string) ?? (args.file as string) ?? ""
    return `impact:${f}`
  }

  // Write/edit: file is significant; the content hash is not (edits differ).
  if (tool === "write" || tool === "write_file" || tool === "create_file" || tool === "edit" || tool === "edit_file" || tool === "patch" || tool === "apply_patch" || tool === "hash-edit" || tool === "str_replace") {
    const f = (args.file as string) ?? (args.filePath as string) ?? (args.path as string) ?? ""
    return `${tool}:${f}`
  }

  // Generic tools: stable stringify of known scalar args (exclude huge outputs).
  try {
    return `${tool}:${stableScalarStringify(args)}`
  } catch {
    return `${tool}:<unfingerprintable>`
  }
}

function normalizeCommand(cmd: string): string {
  return cmd.replace(/\s+/g, " ").trim().replace(/\$HOME\b/gi, "~").toLowerCase()
}

function stableScalarStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return ""
  if (typeof obj !== "object") return String(obj)
  if (Array.isArray(obj)) return `[${obj.map(stableScalarStringify).join(",")}]`
  const record = obj as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const parts: string[] = []
  for (const k of keys) {
    const v = record[k]
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      parts.push(`${k}=${String(v)}`)
    } else if (Array.isArray(v)) {
      parts.push(`${k}=[${v.map(stableScalarStringify).join(",")}]`)
    }
  }
  return `{${parts.join(";")}}`
}

/**
 * Build the deterministic actionable "@HeidiWhatToDoNext" directive from a
 * recoverable loop block. Human escalation is forbidden while a safe
 * autonomous alternative exists.
 */
export function buildRecoveryRedirect(input: {
  sessionID: string
  toolName: string
  fingerprint: string
  reason: string
  blockedFacts: string[]
  available: string[]
}): RecoveryRedirect {
  const { toolName, fingerprint, reason, blockedFacts, available } = input

  const suggestions: string[] = []
  const t = toolName.toLowerCase()

  if (blockedFacts.includes("output_unchanged") || reason === "same_result") {
    suggestions.push("Use the cached prior result from the blocked fingerprint instead of re-executing")
  }
  if (t.startsWith("read") || t === "read_file" || t === "view") {
    suggestions.push("Inspect a materially different line range (change offset/limit)")
    suggestions.push("Outline the file for its symbol structure, then target a specific symbol")
    suggestions.push("Search for the specific symbol rather than re-reading the whole file")
    suggestions.push("Check the file's dependency/impact surface to pick the next meaningful read")
  }
  if (t.includes("search") || t === "grep") {
    suggestions.push("Refine the query with a different, more specific pattern")
    suggestions.push("Scope the search to a different directory or file set")
    suggestions.push("Use the outline of a matched file to continue")
  }
  if (t === "bash" || t === "shell") {
    suggestions.push("Replace the repeated shell command with its equivalent read/search/git fast tool")
    suggestions.push("Run a materially different verification command on the changed input")
  }
  if (t.startsWith("fdx")) {
    suggestions.push("Query the hot index via a different symbol/range/scope")
    suggestions.push("Continue using already-gathered evidence and advance to verification")
  }
  if (suggestions.length === 0) {
    suggestions.push("Advance to the next task step using already-gathered evidence")
    suggestions.push("Use a different tool class to obtain the missing information")
  }
  for (const a of available) {
    if (a && !suggestions.includes(a)) suggestions.push(a)
  }

  return {
    directive: "FLOWDECK_RECOVERY_REDIRECT",
    blockedFingerprint: fingerprint,
    reason: reason.length > 0 ? reason : "same information already obtained",
    doNotRetry: fingerprint,
    continueImmediatelyWith: suggestions.slice(0, 6),
    humanInputRequired: false,
  }
}

/**
 * Tracks open loop incidents per session, per fingerprint.
 */
export class LoopIncidentTracker {
  private incidents = new Map<string, LoopIncidentState>() // key: sessionID + ":" + fingerprint
  private sessionFingerprints = new Map<string, Set<string>>()

  private key(sessionID: string, fingerprint: string): string {
    return `${sessionID}::${fingerprint}`
  }

  /** Mark a real executed repeat of an action that produced no new information. */
  recordNoProgressExecution(sessionID: string, fingerprint: string): LoopIncidentState {
    const k = this.key(sessionID, fingerprint)
    let incident = this.incidents.get(k)
    const now = Date.now()
    if (!incident) {
      incident = {
        incidentId: `loop_${sessionID.slice(0, 8)}_${now}`,
        sessionID,
        fingerprint,
        blockedCount: 0,
        executedRepeatCount: 1,
        openedAt: now,
        lastBlockedAt: now,
        status: "OPEN",
      }
      this.incidents.set(k, incident)
      let fps = this.sessionFingerprints.get(sessionID)
      if (!fps) {
        fps = new Set()
        this.sessionFingerprints.set(sessionID, fps)
      }
      fps.add(fingerprint)
    } else {
      incident.executedRepeatCount++
      incident.lastBlockedAt = now
      incident.status = "OPEN"
    }
    return incident
  }

  /**
   * Record a suppressed duplicate (blocked attempt). It did NOT execute, so it
   * must NOT increment the executed-repeat count.
   */
  recordSuppressedDuplicate(sessionID: string, fingerprint: string): LoopIncidentState {
    const k = this.key(sessionID, fingerprint)
    const now = Date.now()
    let incident = this.incidents.get(k)
    if (!incident) {
      incident = {
        incidentId: `loop_${sessionID.slice(0, 8)}_${now}`,
        sessionID,
        fingerprint,
        blockedCount: 1,
        executedRepeatCount: 0,
        openedAt: now,
        lastBlockedAt: now,
        status: "OPEN",
      }
      this.incidents.set(k, incident)
    } else {
      incident.blockedCount++
      incident.lastBlockedAt = now
    }
    return incident
  }

  attachRedirect(sessionID: string, fingerprint: string, redirect: RecoveryRedirect): void {
    const k = this.key(sessionID, fingerprint)
    const incident = this.incidents.get(k)
    if (incident) incident.lastRecoveryDirective = redirect
  }

  isFingerprintBlocked(sessionID: string, fingerprint: string): boolean {
    const k = this.key(sessionID, fingerprint)
    const incident = this.incidents.get(k)
    return incident?.status === "OPEN"
  }

  getIncident(sessionID: string, fingerprint: string): LoopIncidentState | undefined {
    return this.incidents.get(this.key(sessionID, fingerprint))
  }

  /**
   * Resolve an incident when material new information/progress arrives on a
   * materially different operation.
   */
  resolveIncident(sessionID: string, fingerprint: string): void {
    const k = this.key(sessionID, fingerprint)
    const incident = this.incidents.get(k)
    if (incident) {
      incident.status = "RESOLVED"
    }
  }

  resolveAllForSession(sessionID: string): void {
    for (const [_k, incident] of this.incidents.entries()) {
      if (incident.sessionID === sessionID) incident.status = "RESOLVED"
    }
  }

  clearSession(sessionID: string): void {
    for (const [k, incident] of this.incidents.entries()) {
      if (incident.sessionID === sessionID) this.incidents.delete(k)
    }
    this.sessionFingerprints.delete(sessionID)
  }

  clearAll(): void {
    this.incidents.clear()
    this.sessionFingerprints.clear()
  }

  getOpenIncidents(sessionID: string): LoopIncidentState[] {
    return Array.from(this.incidents.values()).filter(i => i.sessionID === sessionID && i.status === "OPEN")
  }
}

export const loopIncidentTracker = new LoopIncidentTracker()
