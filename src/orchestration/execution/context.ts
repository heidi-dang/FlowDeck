import { buildAssignmentContext, type AssignmentContextResult } from "../../services/context-scoping"

export interface WorkstreamContextInput {
  workstreamId: string
  objective: string
  ownedPaths: string[]
  requirements: string[]
  acceptanceCriteria: string[]
  contextScope: "owned" | "related" | "audit"
  strategy: string
  dependencyEvidence?: string[]
  runtimeProjection?: string
}

/** Build the bounded child packet consumed by an execution workstream. */
export function buildWorkstreamContext(input: WorkstreamContextInput, artifactReferences: string[] = [], runtimeProjection?: string): AssignmentContextResult {
  return buildAssignmentContext({
    target: input.workstreamId,
    patterns: input.ownedPaths,
    assignment: input.objective,
    constraints: `Strategy: ${input.strategy}. Context scope: ${input.contextScope}. Requirements: ${input.requirements.join("; ")}`,
    acceptanceCriteria: input.acceptanceCriteria,
    relevantFiles: input.ownedPaths,
    externalizedArtifacts: [...(input.dependencyEvidence ?? []), ...artifactReferences],
    runtimeProjection: runtimeProjection ?? input.runtimeProjection,
  })
}
