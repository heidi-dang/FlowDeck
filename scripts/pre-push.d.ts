export const root: string
export function parsePrePushStdin(stdinText?: string): Array<{
  localRef: string
  localSha: string
  remoteRef: string
  remoteSha: string
}>
export function detectRustChangesFromRefs(
  refEntries: Array<{ localRef: string; localSha: string; remoteRef: string; remoteSha: string }>,
  cwd?: string
): boolean | null
export function detectRustChanges(stdinText?: string, cwd?: string): boolean
export function getRequiredSteps(
  rustChanged: boolean,
  hasCargo: boolean
): Array<{ name: string; cmd: string }>
