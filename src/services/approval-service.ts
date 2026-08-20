/**
 * FlowDeck Approval Service (FlowDeck v2.2.7)
 *
 * Manages explicit User Approvals for high-risk / sensitive / external operations.
 * Enforces one-shot, scoped, fingerprinted authorization transitions:
 *   pending -> approved -> consumed (single-shot execution)
 *   pending -> denied
 *   pending -> expired
 *
 * Implements anti-flood deduplication to prevent sound/card loops and token-churning retry loops.
 */

export type AuthorizationDecision = "ALLOW" | "APPROVAL_REQUIRED" | "DENY_INVALID"

export type RiskLevel = "normal" | "elevated" | "high" | "critical"

export type RiskCategory =
  | "read_inspection"
  | "workspace_development"
  | "sensitive_data"
  | "external_git"
  | "package_release"
  | "privileged_system"
  | "infrastructure_deployment"
  | "destructive_external"

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "consumed"

export interface ApprovalRequest {
  approval_id: string
  session_id: string
  tool: string
  normalized_action: string
  scope: string
  target: string
  cwd: string
  workspace: string
  risk_level: RiskLevel
  risk_category: RiskCategory
  reason: string
  reversible: boolean
  is_external: boolean
  exact_fingerprint: string
  status: ApprovalStatus
  requested_at: number
  expires_at: number
  denied_reason?: string
  consumed_at?: number
  decision_at?: number
}

export interface ApprovalEvent {
  type: "approval.requested" | "approval.approved" | "approval.denied" | "approval.consumed" | "approval.expired"
  approval: ApprovalRequest
}

export type ApprovalListener = (event: ApprovalEvent) => void

export class FlowDeckApprovalRegistry {
  private approvals = new Map<string, ApprovalRequest>()
  private sessionApprovals = new Map<string, Set<string>>()
  private fingerprintToApproval = new Map<string, string>()
  private listeners = new Set<ApprovalListener>()
  private defaultTtlMs = 15 * 60 * 1000 // 15 minutes default

  addListener(listener: ApprovalListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(type: ApprovalEvent["type"], approval: ApprovalRequest): void {
    const event: ApprovalEvent = { type, approval }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // Safe listener isolation
      }
    }
  }

  requestApproval(params: {
    sessionId: string
    tool: string
    normalizedAction: string
    cwd?: string
    workspace?: string
    riskLevel: RiskLevel
    riskCategory: RiskCategory
    reason: string
    scope?: string
    target?: string
    reversible?: boolean
    isExternal?: boolean
    exactFingerprint: string
    ttlMs?: number
  }): ApprovalRequest {
    const key = `${params.sessionId}:${params.exactFingerprint}`
    const existingId = this.fingerprintToApproval.get(key)
    if (existingId) {
      const existing = this.approvals.get(existingId)
      if (existing) {
        if (existing.status === "pending") {
          if (Date.now() > existing.expires_at) {
            existing.status = "expired"
            this.emit("approval.expired", existing)
          } else {
            return existing
          }
        }
      }
    }

    const now = Date.now()
    const approvalId = `appr_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const expiresAt = now + (params.ttlMs ?? this.defaultTtlMs)

    const request: ApprovalRequest = {
      approval_id: approvalId,
      session_id: params.sessionId,
      tool: params.tool,
      normalized_action: params.normalizedAction,
      scope: params.scope ?? "workspace boundary",
      target: params.target ?? "external or sensitive resource",
      cwd: params.cwd ?? process.cwd(),
      workspace: params.workspace ?? process.cwd(),
      risk_level: params.riskLevel,
      risk_category: params.riskCategory,
      reason: params.reason,
      reversible: params.reversible ?? false,
      is_external: params.isExternal ?? true,
      exact_fingerprint: params.exactFingerprint,
      status: "pending",
      requested_at: now,
      expires_at: expiresAt,
    }

    this.approvals.set(approvalId, request)
    this.fingerprintToApproval.set(key, approvalId)

    if (!this.sessionApprovals.has(params.sessionId)) {
      this.sessionApprovals.set(params.sessionId, new Set())
    }
    this.sessionApprovals.get(params.sessionId)!.add(approvalId)

    this.emit("approval.requested", request)
    return request
  }

  getApproval(approvalId: string): ApprovalRequest | null {
    const req = this.approvals.get(approvalId)
    if (!req) return null
    if (req.status === "pending" && Date.now() > req.expires_at) {
      req.status = "expired"
      this.emit("approval.expired", req)
    }
    return req
  }

  hasApproved(sessionId: string, exactFingerprint: string): boolean {
    const key = `${sessionId}:${exactFingerprint}`
    const approvalId = this.fingerprintToApproval.get(key)
    if (!approvalId) return false
    const req = this.approvals.get(approvalId)
    if (!req) return false
    if (req.status === "approved") {
      if (Date.now() > req.expires_at) {
        req.status = "expired"
        this.emit("approval.expired", req)
        return false
      }
      return true
    }
    return false
  }

  approve(approvalId: string): boolean {
    const req = this.getApproval(approvalId)
    if (!req || req.status !== "pending") return false
    req.status = "approved"
    req.decision_at = Date.now()
    this.emit("approval.approved", req)
    return true
  }

  deny(approvalId: string, reason?: string): boolean {
    const req = this.getApproval(approvalId)
    if (!req || req.status !== "pending") return false
    req.status = "denied"
    req.decision_at = Date.now()
    req.denied_reason = reason ?? "User denied request"
    this.emit("approval.denied", req)
    return true
  }

  consume(sessionId: string, exactFingerprint: string): boolean {
    const key = `${sessionId}:${exactFingerprint}`
    const approvalId = this.fingerprintToApproval.get(key)
    if (!approvalId) return false
    const req = this.approvals.get(approvalId)
    if (!req || req.status !== "approved") return false
    req.status = "consumed"
    req.consumed_at = Date.now()
    this.fingerprintToApproval.delete(key)
    this.emit("approval.consumed", req)
    return true
  }

  getStrategyState(sessionId: string, exactFingerprint: string): ApprovalStatus | "none" {
    const key = `${sessionId}:${exactFingerprint}`
    const approvalId = this.fingerprintToApproval.get(key)
    if (!approvalId) return "none"
    const req = this.getApproval(approvalId)
    return req ? req.status : "none"
  }

  formatApprovalCard(req: ApprovalRequest): string {
    const riskBadge = req.risk_level.toUpperCase()
    return [
      `[FlowDeck Approval Required - ${riskBadge} RISK]`,
      `Approval ID : ${req.approval_id}`,
      `Action      : ${req.normalized_action}`,
      `Scope       : ${req.scope}`,
      `Target      : ${req.target}`,
      `Category    : ${req.risk_category}`,
      `Reason      : ${req.reason}`,
      `Reversible  : ${req.reversible ? "Yes" : "No"}`,
      `Status      : WAITING_FOR_APPROVAL`,
      "",
      `To proceed, approve this action via FlowDeck Web UI / CLI or provide an authorized approval ID.`,
    ].join("\n")
  }

  clearSession(sessionId: string): void {
    const ids = this.sessionApprovals.get(sessionId)
    if (ids) {
      for (const id of ids) {
        const req = this.approvals.get(id)
        if (req) {
          const key = `${sessionId}:${req.exact_fingerprint}`
          this.fingerprintToApproval.delete(key)
        }
        this.approvals.delete(id)
      }
      this.sessionApprovals.delete(sessionId)
    }
  }

  clearAll(): void {
    this.approvals.clear()
    this.sessionApprovals.clear()
    this.fingerprintToApproval.clear()
  }
}

export const flowDeckApprovalRegistry = new FlowDeckApprovalRegistry()
