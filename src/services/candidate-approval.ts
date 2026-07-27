/**
 * Candidate Mutation and Primary Agent Approval Service
 *
 * Specialist agents can propose candidates, but candidate state mutations
 * remain pending until approved by a primary agent (heidi or orchestrator).
 * Mutations are written using atomic advisory file locks (`withLock`) to prevent corruption.
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { withLock } from "./async-lock"
import { isSpecialistAgent } from "./canonical-registry"

export interface ProposedCandidate {
  id: string
  proposedBy: string
  key: string
  value: unknown
  status: "pending" | "approved" | "rejected"
  createdAt: number
}

function candidatePendingPath(directory: string, candidateId: string): string {
  return join(directory, `.candidate_pending_${candidateId}.json`)
}

function candidateApprovedPath(directory: string, candidateId: string): string {
  return join(directory, `.candidate_approved_${candidateId}.json`)
}

export function proposeCandidate(
  directory: string,
  proposedBy: string,
  candidateId: string,
  key: string,
  value: unknown
): ProposedCandidate {
  const candidate: ProposedCandidate = {
    id: candidateId,
    proposedBy,
    key,
    value,
    status: "pending",
    createdAt: Date.now(),
  }
  const pPath = candidatePendingPath(directory, candidateId)
  writeFileSync(pPath, JSON.stringify(candidate, null, 2), "utf-8")
  return candidate
}

export function loadCandidatePending(directory: string, candidateId: string): ProposedCandidate | null {
  const pPath = candidatePendingPath(directory, candidateId)
  if (!existsSync(pPath)) return null
  try {
    return JSON.parse(readFileSync(pPath, "utf-8"))
  } catch {
    return null
  }
}

export function loadCandidateApproved(directory: string, candidateId: string): ProposedCandidate | null {
  const aPath = candidateApprovedPath(directory, candidateId)
  if (!existsSync(aPath)) return null
  try {
    return JSON.parse(readFileSync(aPath, "utf-8"))
  } catch {
    return null
  }
}

export async function approveCandidate(
  directory: string,
  approvedByAgent: string,
  candidateId: string
): Promise<{ success: boolean; candidate?: ProposedCandidate; error?: string }> {
  // Specialist agent CANNOT approve candidate mutations — only primary agents (heidi or orchestrator)
  if (isSpecialistAgent(approvedByAgent)) {
    return {
      success: false,
      error: `Specialist agent "${approvedByAgent}" cannot approve durable candidate mutations. Primary agent approval required.`,
    }
  }

  const lockPath = join(directory, `.candidate_${candidateId}.lock`)
  return await withLock(lockPath, async () => {
    const candidate = loadCandidatePending(directory, candidateId)
    if (!candidate) {
      const existingApproved = loadCandidateApproved(directory, candidateId)
      if (existingApproved) {
        // Idempotent approval
        return { success: true, candidate: existingApproved }
      }
      return { success: false, error: `Candidate "${candidateId}" not found or already processed.` }
    }

    candidate.status = "approved"
    const aPath = candidateApprovedPath(directory, candidateId)
    writeFileSync(aPath, JSON.stringify(candidate, null, 2), "utf-8")

    const pPath = candidatePendingPath(directory, candidateId)
    if (existsSync(pPath)) {
      try { rmSync(pPath, { force: true }) } catch {}
    }

    return { success: true, candidate }
  })
}

export async function rejectCandidate(
  directory: string,
  rejectedByAgent: string,
  candidateId: string
): Promise<{ success: boolean; error?: string }> {
  const lockPath = join(directory, `.candidate_${candidateId}.lock`)
  return await withLock(lockPath, async () => {
    const candidate = loadCandidatePending(directory, candidateId)
    if (!candidate) {
      return { success: false, error: `Candidate "${candidateId}" not found.` }
    }

    const pPath = candidatePendingPath(directory, candidateId)
    if (existsSync(pPath)) {
      try { rmSync(pPath, { force: true }) } catch {}
    }

    return { success: true }
  })
}
