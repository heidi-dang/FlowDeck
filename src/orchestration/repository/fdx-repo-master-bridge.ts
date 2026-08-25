/**
 * FDX → Repo Master Integration
 *
 * Makes Repo Master consume FDX intelligence for deterministic repository facts:
 * - files, symbols, dependencies, impact, change scope, test surface
 *
 * Architecture rule:
 *   FDX = repository facts (authoritative, deterministic)
 *   Repo Master = repository understanding (architectural interpretation, conventions)
 *   Heidi = orchestration decision
 *   Specialist = execution
 *
 * Repo Master must NOT rescan the entire repository when FDX already has valid evidence.
 */

import type { FdxCapabilitySnapshot, FdxChangeIntelligence } from "../../services/fdx-vci-adapter"

// ─── FDX-augmented Repo Master facts ────────────────────────────────────────

export interface FdxRepoFacts {
  /** Sourced from FDX evidence graph */
  changedFiles: string[]
  /** Directly or transitively impacted files */
  impactedFiles: string[]
  /** Packages/workspaces affected */
  impactedPackages: string[]
  /** Files FDX is uncertain about (dynamic imports, generated, etc.) */
  uncertainFiles: string[]
  /** Assurance level of the facts */
  assuranceLevel: string
  /** FDX provider state used */
  providerState: string
  /** True when FDX facts are fresh (not stale from a prior run) */
  isFresh: boolean
}

/**
 * Convert FDX change intelligence into structured Repo Master facts.
 *
 * This is the bridge that lets Repo Master use FDX evidence instead of
 * performing its own repository traversal for facts FDX already has.
 */
export function fdxIntelligenceToRepoFacts(
  intelligence: FdxChangeIntelligence | null,
  capabilities: FdxCapabilitySnapshot
): FdxRepoFacts {
  if (!intelligence) {
    return {
      changedFiles: [],
      impactedFiles: [],
      impactedPackages: [],
      uncertainFiles: [],
      assuranceLevel: "unavailable",
      providerState: capabilities.providerState,
      isFresh: false,
    }
  }

  return {
    changedFiles: intelligence.changedFiles,
    impactedFiles: intelligence.impactedFiles,
    impactedPackages: intelligence.impactedPackages,
    uncertainFiles: intelligence.uncertainFiles,
    assuranceLevel: intelligence.assuranceLevel,
    providerState: intelligence.providerState,
    isFresh: true,
  }
}

/**
 * Determine if Repo Master should use FDX facts or fall back to its own analysis.
 *
 * Repo Master uses FDX facts when:
 * - FDX provider is native (full or partial)
 * - Intelligence is for the same runId
 * - Intelligence contains relevant change data
 *
 * Repo Master falls back to its own analysis when FDX is in TypeScript fallback
 * or when the intelligence does not cover the current change.
 */
export function shouldUseFdxFacts(
  intelligence: FdxChangeIntelligence | null,
  capabilities: FdxCapabilitySnapshot,
  runId: string
): boolean {
  if (!intelligence) return false
  if (intelligence.runId !== runId) return false
  if (
    capabilities.providerState !== "native_vci_full" &&
    capabilities.providerState !== "native_vci_partial"
  ) return false
  return true
}

/**
 * Enrich Repo Master advice with FDX facts.
 *
 * Merges FDX's deterministic repository facts (changed files, impact, packages)
 * with Repo Master's architectural interpretation (risk areas, constraints).
 *
 * The enriched advice is what flows to Heidi and specialists.
 */
export function enrichRepoMasterAdviceWithFdx<T extends {
  relevantFiles: string[]
  relevantPackages: string[]
  likelyTests: string[]
}>(
  advice: T,
  facts: FdxRepoFacts
): T {
  if (!facts.isFresh) return advice

  // Merge FDX impacted files with Repo Master's relevant files
  const mergedFiles = [...new Set([...advice.relevantFiles, ...facts.impactedFiles])].slice(0, 24)
  // Merge FDX packages with Repo Master's packages
  const mergedPackages = [...new Set([...advice.relevantPackages, ...facts.impactedPackages])].slice(0, 24)
  // Add uncertain files to likely tests if they look like test files
  const testPattern = /(\.test\.|\.spec\.|\/tests?\/)/
  const fdxTests = facts.uncertainFiles.filter(f => testPattern.test(f))
  const mergedTests = [...new Set([...advice.likelyTests, ...fdxTests])].slice(0, 12)

  return {
    ...advice,
    relevantFiles: mergedFiles,
    relevantPackages: mergedPackages,
    likelyTests: mergedTests,
  }
}