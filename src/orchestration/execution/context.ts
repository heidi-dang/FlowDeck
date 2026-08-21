export interface WorkstreamContextInput {
  workstreamId: string
  objective: string
  strategy: string
  contextScope: string
  requirements: string[]
  acceptanceCriteria: string[]
  ownedPaths: string[]
  _runtimeProjection?: string
}

export interface HeidiTaskAssignment {
  objective: string;
  requirements: string[];
  acceptanceCriteria: string[];
  relevantPaths: string[];
  strategy: string;
  artifactReferences?: string[];
  runtimeProjection?: string;
}

export function buildWorkstreamContext(input: WorkstreamContextInput, artifactReferences: string[] = [], runtimeProjection?: string): HeidiTaskAssignment {
  return {
    objective: input.objective,
    requirements: input.requirements,
    acceptanceCriteria: input.acceptanceCriteria,
    relevantPaths: input.ownedPaths,
    strategy: input.strategy,
    artifactReferences,
    runtimeProjection
  };
}
