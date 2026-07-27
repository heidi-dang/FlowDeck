export const root: string

export interface RefEntry {
  localRef: string
  localSha: string
  remoteRef: string
  remoteSha: string
}

export type ExecFn = (cmd: string, cwd?: string) => string

export class ChangedFilesResult {
  files: string[]
  source: "refs" | "working-tree"
  trustworthy: boolean
  constructor(files: string[], source: "refs" | "working-tree", trustworthy: boolean)
}

export function parsePrePushStdin(stdinText?: string): RefEntry[]

export function readPrePushInput(opts?: { isTTY?: boolean; readFn?: (fd: number) => string }): string

export function detectRustChangesFromRefs(
  refEntries: RefEntry[] | null,
  cwd?: string,
  execFn?: ExecFn
): boolean | null

export function detectRustChanges(stdinText?: string, cwd?: string, execFn?: ExecFn): boolean

export function getChangedFiles(stdinText?: string, cwd?: string, execFn?: ExecFn): ChangedFilesResult

export function isEscalationRequired(changedFiles: string[]): boolean

export interface FastTask {
  name: string
  executable: string
  args: string[]
}

export interface FastChecks {
  testPaths: string[]
  fastTasks: FastTask[]
}

export function routeFastChecks(changedFiles: string[]): FastChecks

export function resolveOxlintExecutable(): string

export function getBunExecutable(): string

export function resolveTscPath(): string

export function resolvePushRanges(stdinText?: string, cwd?: string, execFn?: ExecFn): Array<{ baseSha: string; localSha: string }>

export function getDiffCheckTasks(ranges: Array<{ baseSha: string; localSha: string }>): FastTask[]

export function getFullModeSteps(
  rustChanged: boolean,
  hasCargo: boolean
): Array<{ name: string; cmd: string }>
