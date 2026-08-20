import { describe, it, expect, beforeEach } from "bun:test"
import { FlowDeckApprovalRegistry } from "../../src/services/approval-service"

describe("FlowDeck v2.2.7 Approval Registry & State Machine", () => {
  let registry: FlowDeckApprovalRegistry

  beforeEach(() => {
    registry = new FlowDeckApprovalRegistry()
  })

  it("creates a pending approval request with deterministic fingerprint", () => {
    const req = registry.requestApproval({
      sessionId: "ses_123",
      tool: "bash",
      normalizedAction: "git push origin main",
      cwd: "/home/user/app",
      workspace: "/home/user/app",
      riskLevel: "high",
      riskCategory: "external_git",
      reason: "Pushing commits to remote repository",
      scope: "remote git repository",
      target: "origin",
      exactFingerprint: "bash:git push origin main",
    })

    expect(req.approval_id).toMatch(/^appr_/)
    expect(req.status).toBe("pending")
    expect(req.exact_fingerprint).toBe("bash:git push origin main")
    expect(registry.hasApproved("ses_123", "bash:git push origin main")).toBe(false)
  })

  it("deduplicates multiple pending approval requests for identical fingerprint (no flood)", () => {
    const req1 = registry.requestApproval({
      sessionId: "ses_123",
      tool: "bash",
      normalizedAction: "git push origin main",
      riskLevel: "high",
      riskCategory: "external_git",
      reason: "Pushing commits to remote repository",
      exactFingerprint: "bash:git push origin main",
    })

    const req2 = registry.requestApproval({
      sessionId: "ses_123",
      tool: "bash",
      normalizedAction: "git push origin main",
      riskLevel: "high",
      riskCategory: "external_git",
      reason: "Pushing commits to remote repository",
      exactFingerprint: "bash:git push origin main",
    })

    expect(req1.approval_id).toBe(req2.approval_id)
  })

  it("handles approve -> hasApproved -> consume one-shot lifecycle", () => {
    const events: string[] = []
    registry.addListener((e) => events.push(e.type))

    const req = registry.requestApproval({
      sessionId: "ses_123",
      tool: "bash",
      normalizedAction: "git push origin main",
      riskLevel: "high",
      riskCategory: "external_git",
      reason: "git push",
      exactFingerprint: "bash:git push origin main",
    })

    expect(registry.hasApproved("ses_123", "bash:git push origin main")).toBe(false)

    const approved = registry.approve(req.approval_id)
    expect(approved).toBe(true)
    expect(events).toContain("approval.approved")
    expect(registry.hasApproved("ses_123", "bash:git push origin main")).toBe(true)

    const consumed = registry.consume("ses_123", "bash:git push origin main")
    expect(consumed).toBe(true)
    expect(events).toContain("approval.consumed")

    expect(registry.hasApproved("ses_123", "bash:git push origin main")).toBe(false)
  })

  it("handles denial transition", () => {
    const events: string[] = []
    registry.addListener((e) => events.push(e.type))

    const req = registry.requestApproval({
      sessionId: "ses_123",
      tool: "bash",
      normalizedAction: "npm publish",
      riskLevel: "critical",
      riskCategory: "package_release",
      reason: "npm publish",
      exactFingerprint: "bash:npm publish",
    })

    const denied = registry.deny(req.approval_id, "User declined release publish")
    expect(denied).toBe(true)
    expect(events).toContain("approval.denied")
    expect(registry.hasApproved("ses_123", "bash:npm publish")).toBe(false)
    expect(registry.getStrategyState("ses_123", "bash:npm publish")).toBe("denied")
  })

  it("handles expiration lifecycle", () => {
    const events: string[] = []
    registry.addListener((e) => events.push(e.type))

    registry.requestApproval({
      sessionId: "ses_123",
      tool: "bash",
      normalizedAction: "git push origin main",
      riskLevel: "high",
      riskCategory: "external_git",
      reason: "git push",
      exactFingerprint: "bash:git push origin main",
      ttlMs: -1000,
    })

    expect(registry.hasApproved("ses_123", "bash:git push origin main")).toBe(false)
    expect(registry.getStrategyState("ses_123", "bash:git push origin main")).toBe("expired")
    expect(events).toContain("approval.expired")
  })

  it("isolates approvals across different sessions", () => {
    const req = registry.requestApproval({
      sessionId: "ses_A",
      tool: "bash",
      normalizedAction: "git push origin main",
      riskLevel: "high",
      riskCategory: "external_git",
      reason: "git push",
      exactFingerprint: "bash:git push origin main",
    })

    registry.approve(req.approval_id)

    expect(registry.hasApproved("ses_A", "bash:git push origin main")).toBe(true)
    expect(registry.hasApproved("ses_B", "bash:git push origin main")).toBe(false)
  })

  it("clears session approvals upon session termination", () => {
    registry.requestApproval({
      sessionId: "ses_123",
      tool: "bash",
      normalizedAction: "git push",
      cwd: "/repo",
      workspace: "/repo",
      riskLevel: "high",
      riskCategory: "external_git",
      reason: "git push to remote",
      scope: "remote",
      target: "origin",
      exactFingerprint: "bash:git push",
    })

    expect(registry.getStrategyState("ses_123", "bash:git push")).toBe("pending")

    registry.clearSession("ses_123")
    expect(registry.getStrategyState("ses_123", "bash:git push")).toBe("none")
  })

  it("formats human-readable approval cards for UI/CLI", () => {
    const req = registry.requestApproval({
      sessionId: "ses_123",
      tool: "bash",
      normalizedAction: "git push --force origin main",
      riskLevel: "critical",
      riskCategory: "external_git",
      reason: "git push with force rewrites remote history on external repository",
      scope: "remote Git repository",
      target: "origin",
      exactFingerprint: "bash:git push --force origin main",
    })

    const card = registry.formatApprovalCard(req)
    expect(card).toContain("[FlowDeck Approval Required - CRITICAL RISK]")
    expect(card).toContain("git push --force origin main")
    expect(card).toContain("WAITING_FOR_APPROVAL")
  })
})
