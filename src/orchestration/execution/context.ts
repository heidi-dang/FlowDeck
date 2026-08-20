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
export function buildWorkstreamContext(_input: WorkstreamContextInput, _artifactReferences: string[] = [], _runtimeProjection?: string): any {
  return {} as any;
}
