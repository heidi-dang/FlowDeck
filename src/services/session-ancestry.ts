/**
 * Session Ancestry & Coordinator Provenance Runtime
 *
 * Enforces:
 * 1. Root Heidi session is ALWAYS depth 0 regardless of late events, continuations,
 *    or message-level parentID metadata.
 * 2. Session parentID is STRICTLY separated from Message parentID (causal correlation).
 * 3. Direct specialist child sessions are depth 1.
 * 4. Specialist recursive delegation is BLOCKED at depth 1.
 * 5. Generic depth > maxDepth is BLOCKED.
 * 6. Authoritative coordinator classification: an agent starting as root Heidi
 *    retains root coordinator status unless explicitly registered as a spawned child.
 */

import { isHeidiAgent, isSpecialistAgent } from "./canonical-registry"

export interface SessionAncestryRecord {
  sessionID: string
  parentSessionID?: string
  agent: string
  depth: number
  isRootCoordinator: boolean
  createdAt: number
  updatedAt: number
}

export class SessionAncestryRegistry {
  private sessions = new Map<string, SessionAncestryRecord>()

  /**
   * Register or update a session with explicit provenance.
   * Session-level parentSessionID must only be set when this session was
   * explicitly spawned as a child of parentSessionID.
   */
  registerSession(
    sessionID: string,
    agent?: string,
    parentSessionID?: string,
    explicitDepth?: number
  ): SessionAncestryRecord {
    if (!sessionID) {
      throw new Error("SESSION_ID_REQUIRED: Cannot register session without sessionID")
    }

    const existing = this.sessions.get(sessionID)
    const now = Date.now()
    const effectiveAgent = agent && agent !== "unknown" ? agent : existing?.agent ?? ""

    // Clean up empty strings
    const effectiveParentSessionID =
      parentSessionID && parentSessionID.trim() !== "" ? parentSessionID.trim() : undefined

    let depth = 0
    let isRootCoordinator = false

    if (effectiveParentSessionID) {
      const parentRecord = this.sessions.get(effectiveParentSessionID)
      depth = explicitDepth !== undefined ? explicitDepth : parentRecord ? parentRecord.depth + 1 : 1
      isRootCoordinator = false
    } else {
      // No parent session: if it's a heidi/orchestrator agent or has no parent, it's root depth 0
      if (isHeidiAgent(effectiveAgent) || !isSpecialistAgent(effectiveAgent)) {
        depth = 0
        isRootCoordinator = true
      } else {
        // If a specialist agent is launched with no parent registered, it is a subagent at depth 1
        depth = explicitDepth !== undefined ? explicitDepth : 1
        isRootCoordinator = false
      }
    }

    // Never demote a root coordinator to depth > 0 due to subsequent events unless explicitly given a parentSessionID
    if (existing) {
      // Preserve root coordinator if no valid parent session ID is introduced
      const mergedParent = effectiveParentSessionID ?? existing.parentSessionID
      const mergedAgent = (agent && agent !== "unknown" ? agent : existing.agent) ?? effectiveAgent
      const mergedDepth = mergedParent
        ? (explicitDepth !== undefined ? explicitDepth : (this.sessions.get(mergedParent)?.depth ?? 0) + 1)
        : (isHeidiAgent(mergedAgent) ? 0 : (existing.depth))

      const updated: SessionAncestryRecord = {
        sessionID,
        parentSessionID: mergedParent,
        agent: mergedAgent,
        depth: mergedDepth,
        isRootCoordinator: !mergedParent && isHeidiAgent(mergedAgent),
        createdAt: existing.createdAt,
        updatedAt: now,
      }
      this.sessions.set(sessionID, updated)
      return updated
    }

    const record: SessionAncestryRecord = {
      sessionID,
      parentSessionID: effectiveParentSessionID,
      agent: effectiveAgent,
      depth,
      isRootCoordinator,
      createdAt: now,
      updatedAt: now,
    }
    this.sessions.set(sessionID, record)
    return record
  }

  /**
   * Get session ancestry record if known.
   */
  getSession(sessionID: string): SessionAncestryRecord | undefined {
    return this.sessions.get(sessionID)
  }

  /**
   * Authoritative calculation of depth for delegation validation.
   */
  getEffectiveDepth(sessionID: string, callerAgent?: string): number {
    const record = this.sessions.get(sessionID)
    const effectiveAgent = callerAgent || record?.agent || "heidi"

    if (isHeidiAgent(effectiveAgent) && (!record?.parentSessionID || record.isRootCoordinator)) {
      return 0
    }

    if (record) {
      return record.depth
    }

    // Unregistered fallback: root heidi is 0, specialists are 1
    return isHeidiAgent(effectiveAgent) ? 0 : isSpecialistAgent(effectiveAgent) ? 1 : 0
  }

  /**
   * Check if a session is a root coordinator.
   */
  isRootCoordinator(sessionID: string, callerAgent?: string): boolean {
    const record = this.sessions.get(sessionID)
    if (record) return record.isRootCoordinator
    const agent = callerAgent || "heidi"
    return isHeidiAgent(agent)
  }

  /**
   * Clear session registration.
   */
  deleteSession(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  /**
   * Clear all records.
   */
  clear(): void {
    this.sessions.clear()
  }
}

export const sessionAncestry = new SessionAncestryRegistry()
