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

    // A parent session ID is valid ONLY if it points to a distinct, registered session in this registry
    const parentRecord = effectiveParentSessionID && effectiveParentSessionID !== sessionID
      ? this.sessions.get(effectiveParentSessionID)
      : undefined
    const validParentSessionID = parentRecord ? effectiveParentSessionID : undefined

    if (validParentSessionID && parentRecord) {
      depth = explicitDepth !== undefined ? explicitDepth : parentRecord.depth + 1
      isRootCoordinator = false
    } else {
      // No valid registered parent session: root session is ALWAYS depth 0
      depth = explicitDepth !== undefined ? explicitDepth : 0
      isRootCoordinator = true
    }

    // Never demote a root coordinator to depth > 0 due to subsequent events unless explicitly given a valid parentSessionID
    if (existing) {
      const mergedParent = validParentSessionID ?? existing.parentSessionID
      const mergedParentRecord = mergedParent ? this.sessions.get(mergedParent) : undefined
      const mergedAgent = (agent && agent !== "unknown" ? agent : existing.agent) ?? effectiveAgent
      const isRoot = !mergedParent || existing.isRootCoordinator
      const mergedDepth = isRoot
        ? 0
        : (explicitDepth !== undefined ? explicitDepth : (mergedParentRecord ? mergedParentRecord.depth + 1 : existing.depth))

      const updated: SessionAncestryRecord = {
        sessionID,
        parentSessionID: isRoot ? undefined : mergedParent,
        agent: mergedAgent,
        depth: mergedDepth,
        isRootCoordinator: isRoot,
        createdAt: existing.createdAt,
        updatedAt: now,
      }
      this.sessions.set(sessionID, updated)
      return updated
    }

    const record: SessionAncestryRecord = {
      sessionID,
      parentSessionID: validParentSessionID,
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
