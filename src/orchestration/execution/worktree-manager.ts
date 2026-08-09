import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs"
import { join, relative, resolve, sep } from "node:path"

export interface WorktreeAllocation { worktreeId: string; workspace: string; branch: string; sourceSha: string }
function safePart(value: string): string { const out = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, ""); if (!out) throw new Error("UNSAFE_WORKTREE_IDENTIFIER"); return out.slice(0, 80) }
function contained(root: string, candidate: string): boolean { const rel = relative(root, candidate); return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep) }

/** Git worktree boundary. It uses argument-array subprocess calls only and never mutates the root checkout. */
export class GitWorktreeManager {
  private readonly root: string
  constructor(private readonly repository: string, root: string) {
    mkdirSync(root, { recursive: true }); this.root = realpathSync(root)
  }
  allocate(runId: string, workstreamId: string, sourceSha: string): WorktreeAllocation {
    if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error("INVALID_SOURCE_SHA")
    const worktreeId = `${safePart(runId)}-${safePart(workstreamId)}`; const branch = `flowdeck/${worktreeId}`; const workspace = join(this.root, worktreeId)
    if (!contained(this.root, workspace) || existsSync(workspace)) throw new Error("WORKTREE_COLLISION")
    execFileSync("git", ["worktree", "add", "-b", branch, workspace, sourceSha], { cwd: this.repository, stdio: "pipe" })
    return { worktreeId, workspace, branch, sourceSha }
  }
  assertOwnedPath(workspace: string, path: string): string {
    const root = realpathSync(workspace); const candidate = resolve(workspace, path.replaceAll("\\", "/"));
    if (!contained(root, candidate)) throw new Error("OWNERSHIP_PATH_ESCAPE")
    if (existsSync(candidate) && lstatSync(candidate).isSymbolicLink()) { const real = realpathSync(candidate); if (!contained(root, real) && real !== root) throw new Error("SYMLINK_ESCAPE") }
    return candidate
  }
  remove(allocation: WorktreeAllocation): void {
    if (!contained(this.root, resolve(allocation.workspace)) || resolve(allocation.workspace) === resolve(this.repository)) throw new Error("WORKTREE_REMOVE_BOUNDARY")
    execFileSync("git", ["worktree", "remove", "--force", allocation.workspace], { cwd: this.repository, stdio: "pipe" })
    try { execFileSync("git", ["branch", "-D", allocation.branch], { cwd: this.repository, stdio: "pipe" }) } catch { /* branch cleanup is best effort after worktree removal */ }
  }
}
