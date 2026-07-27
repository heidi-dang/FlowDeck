export const root: string

export interface RefEntry {
  localRef: string
  localSha: string
  remoteRef: string
  remoteSha: string
}

export type ExecFn = (cmd: string, cwd?: string) => string

export function parsePrePushStdin(stdinText?: string): RefEntry[]

export function detectRustChangesFromRefs(
  refEntries: RefEntry[] | null,
  cwd?: string,
  execFn?: ExecFn
): boolean | null

export function detectRustChanges(stdinText?: string, cwd?: string, execFn?: ExecFn): boolean

export function getChangedFiles(stdinText?: string, cwd?: string, execFn?: ExecFn): string[]

export function isEscalationRequired(changedFiles: string[]): boolean

export interface FastChecks {
  testPaths: string[]
  extraCmds: string[]
}

export function routeFastChecks(changedFiles: string[]): FastChecks

export function getFullModeSteps(
  rustChanged: boolean,
  hasCargo: boolean
): Array<{ name: string; cmd: string }>
