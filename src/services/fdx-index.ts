import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve, sep } from "node:path"

export interface FdxIndexOptions {
  stateFile: string
  maxFiles?: number
  maxFileBytes?: number
  maxWorkspaces?: number
  maxSymbolsPerFile?: number
}

export interface FdxIndexedFile {
  path: string
  size: number
  mtimeMs: number
  hash: string
  symbols: string[]
  dependencies: string[]
}

export interface FdxWorkspaceSnapshot {
  workspaceId: string
  workspace: string
  updatedAt: string
  files: FdxIndexedFile[]
}

export interface FdxImpactSnapshot {
  changedPaths: string[]
  affectedPaths: string[]
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value !== ".." && !value.startsWith(`..${sep}`) && !value.startsWith(sep)
}

function workspaceIdentity(workspace: string): { id: string; path: string } {
  const path = existsSync(workspace) ? realpathSync(workspace) : resolve(workspace)
  return { id: createHash("sha256").update(path).digest("hex").slice(0, 32), path }
}

function sourceSymbols(source: string, max: number): string[] {
  const result = new Set<string>()
  const pattern = /\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|fn|struct|trait)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
  for (const match of source.matchAll(pattern)) {
    if (match[1]) result.add(match[1])
    if (result.size >= max) break
  }
  return [...result].sort()
}

function sourceDependencies(source: string): string[] {
  const result = new Set<string>()
  const pattern = /(?:from|require\s*\(|use\s+)[\s"'`]*([^\s"'`(){};]+)/g
  for (const match of source.matchAll(pattern)) if (match[1]) result.add(match[1])
  return [...result].sort().slice(0, 100)
}

function isIgnored(name: string): boolean {
  return name === ".git" || name === ".flowdeck" || name === "node_modules" || name === "target" || name === "coverage"
}

/** Optional persistent workspace index. It is deliberately read-only and bounded;
 * callers still retain the native FDX and TypeScript fallbacks. */
export class FdxWorkspaceIndex {
  private readonly maxFiles: number
  private readonly maxFileBytes: number
  private readonly maxWorkspaces: number
  private readonly maxSymbolsPerFile: number
  private readonly stateFilePath: string
  private readonly state = new Map<string, FdxWorkspaceSnapshot>()

  constructor(private readonly options: FdxIndexOptions) {
    this.maxFiles = options.maxFiles ?? 10_000
    this.maxFileBytes = options.maxFileBytes ?? 2_000_000
    this.maxWorkspaces = options.maxWorkspaces ?? 32
    this.maxSymbolsPerFile = options.maxSymbolsPerFile ?? 500
    this.stateFilePath = resolve(options.stateFile)
    this.load()
  }

  refresh(workspace: string): FdxWorkspaceSnapshot {
    const identity = workspaceIdentity(workspace)
    if (!existsSync(identity.path) || !lstatSync(identity.path).isDirectory()) throw new Error("FDX_WORKSPACE_NOT_FOUND")
    const previous = this.state.get(identity.id)
    if (!previous && this.state.size >= this.maxWorkspaces) throw new Error("FDX_WORKSPACE_LIMIT")
    const previousByPath = new Map((previous?.files ?? []).map(file => [file.path, file]))
    const paths = this.discover(identity.path)
    const files: FdxIndexedFile[] = []
    for (const path of paths) {
      const relativePath = path.slice(identity.path.length + 1).replaceAll(sep, "/")
      const stats = statSync(path)
      const old = previousByPath.get(relativePath)
      if (old && old.size === stats.size && old.mtimeMs === stats.mtimeMs) {
        files.push(old)
        continue
      }
      const source = readFileSync(path, "utf8")
      const hash = createHash("sha256").update(source).digest("hex")
      files.push({ path: relativePath, size: stats.size, mtimeMs: stats.mtimeMs, hash, symbols: sourceSymbols(source, this.maxSymbolsPerFile), dependencies: sourceDependencies(source) })
    }
    files.sort((a, b) => a.path.localeCompare(b.path))
    const index: FdxWorkspaceSnapshot = { workspaceId: identity.id, workspace: identity.path, updatedAt: new Date().toISOString(), files }
    this.state.set(identity.id, index)
    this.persist()
    return this.clone(index)
  }

  get(workspace: string): FdxWorkspaceSnapshot | null {
    const identity = workspaceIdentity(workspace)
    const value = this.state.get(identity.id)
    return value ? this.clone(value) : null
  }

  /** Legacy API: re-scan then query. Kept for existing callers/tests. */
  symbols(workspace: string, query: string, paths?: readonly string[]): Array<{ path: string; symbol: string }> {
    const index = this.refresh(workspace)
    return this.symbolsFromSnapshot(index, query, paths)
  }

  /** Legacy API: re-scan then query. Kept for existing callers/tests. */
  outline(workspace: string, paths?: readonly string[]): Array<{ path: string; symbols: string[] }> {
    const index = this.refresh(workspace)
    return this.outlineFromSnapshot(index, paths)
  }

  /** Legacy API: re-scan then query. Kept for existing callers/tests. */
  impact(workspace: string, paths: readonly string[]): FdxImpactSnapshot {
    const index = this.refresh(workspace)
    return this.impactFromSnapshot(index, paths)
  }

  /**
   * Explicit cold-init: call refresh() only if this workspace has no snapshot
   * yet. A no-op when already initialized, so it is safe to call before warm
   * queries without triggering a workspace walk.
   */
  ensureInitialized(workspace: string): FdxWorkspaceSnapshot {
    const identity = workspaceIdentity(workspace)
    const existing = this.state.get(identity.id)
    if (existing) return this.clone(existing)
    return this.refresh(workspace)
  }

  /** Warm query: reads the RESIDENT snapshot. Never walks the workspace. */
  querySymbols(workspace: string, query: string, paths?: readonly string[]): Array<{ path: string; symbol: string }> {
    return this.symbolsFromSnapshot(this.ensureInitialized(workspace), query, paths)
  }

  /** Warm outline query: no workspace walk when initialized. */
  queryOutline(workspace: string, paths?: readonly string[]): Array<{ path: string; symbols: string[] }> {
    return this.outlineFromSnapshot(this.ensureInitialized(workspace), paths)
  }

  /** Warm impact query: no workspace walk when initialized. */
  queryImpact(workspace: string, paths: readonly string[]): FdxImpactSnapshot {
    return this.impactFromSnapshot(this.ensureInitialized(workspace), paths)
  }

  /**
   * Incremental refresh: re-stat/re-read ONLY the given changed paths into the
   * resident snapshot, never walking the whole workspace. Changed files that
   * still exist are re-indexed; missing ones stay dropped.
   */
  refreshChanged(workspace: string, changedPaths: readonly string[]): FdxWorkspaceSnapshot {
    const identity = workspaceIdentity(workspace)
    const current = this.state.get(identity.id)
    if (!current) return this.refresh(workspace)
    if (!changedPaths.length) return this.clone(current)

    const workspaceRoot = identity.path
    const keep = new Map<string, FdxIndexedFile>()

    for (const file of current.files) {
      let changed = false
      for (const raw of changedPaths) {
        const norm = raw.replaceAll("\\", "/").replace(/^\.\//, "")
        if (file.path === norm || file.path.startsWith(norm + "/")) { changed = true; break }
      }
      if (!changed) keep.set(file.path, file)
    }

    for (const raw of changedPaths) {
      const candidate = resolve(workspaceRoot, raw)
      if (!isInside(workspaceRoot, candidate)) throw new Error("FDX_WORKSPACE_ESCAPE")
      const rel = relative(workspaceRoot, candidate).replaceAll(sep, "/").replace(/\/$/, "")
      let st: ReturnType<typeof statSync> | null = null
      try { st = lstatSync(candidate) } catch { /* missing */ }
      if (!st || !st.isFile()) continue
      const info = statSync(candidate)
      if (info.size > this.maxFileBytes) continue
      const source = readFileSync(candidate, "utf8")
      keep.set(rel, {
        path: rel,
        size: info.size,
        mtimeMs: info.mtimeMs,
        hash: createHash("sha256").update(source).digest("hex"),
        symbols: sourceSymbols(source, this.maxSymbolsPerFile),
        dependencies: sourceDependencies(source),
      })
    }

    const files = [...keep.values()].sort((a, b) => a.path.localeCompare(b.path))
    const index: FdxWorkspaceSnapshot = { workspaceId: identity.id, workspace: workspaceRoot, updatedAt: new Date().toISOString(), files }
    this.state.set(identity.id, index)
    this.persist()
    return this.clone(index)
  }

  invalidate(workspace: string, changedPaths?: readonly string[]): void {
    const identity = workspaceIdentity(workspace)
    const current = this.state.get(identity.id)
    if (!current) return
    if (!changedPaths?.length) { this.state.delete(identity.id); this.persist(); return }
    const changed = new Set(changedPaths.map(path => path.replaceAll("\\", "/").replace(/^\.\//, "")))
    current.files = current.files.filter(file => !changed.has(file.path))
    current.updatedAt = new Date().toISOString()
    this.persist()
  }

  health(): { workspaces: number; files: number } {
    return { workspaces: this.state.size, files: [...this.state.values()].reduce((sum, item) => sum + item.files.length, 0) }
  }

  private symbolsFromSnapshot(index: FdxWorkspaceSnapshot, query: string, paths?: readonly string[]): Array<{ path: string; symbol: string }> {
    const needle = query.trim().toLowerCase()
    return this.selectFiles(index, paths).flatMap(file => file.symbols.filter(symbol => !needle || symbol.toLowerCase().includes(needle)).map(symbol => ({ path: file.path, symbol }))).slice(0, 500)
  }

  private outlineFromSnapshot(index: FdxWorkspaceSnapshot, paths?: readonly string[]): Array<{ path: string; symbols: string[] }> {
    return this.selectFiles(index, paths).map(file => ({ path: file.path, symbols: [...file.symbols] }))
  }

  private impactFromSnapshot(index: FdxWorkspaceSnapshot, paths: readonly string[]): FdxImpactSnapshot {
    const changedPaths = this.relativePaths(index.workspace, paths)
    const changed = new Set(changedPaths)
    const affectedPaths = index.files
      .filter(file => changed.has(file.path) || file.dependencies.some(dependency => {
        const normalized = dependency.replaceAll("\\", "/").replace(/^\.\//, "")
        return changedPaths.some(path => normalized === path || normalized.endsWith(`/${path}`) || path.endsWith(`/${normalized}`) || path.split("/").at(-1) === normalized)
      }))
      .map(file => file.path)
      .sort()
    return { changedPaths, affectedPaths }
  }

  private discover(root: string): string[] {
    const found: string[] = []
    const visit = (directory: string): void => {
      if (found.length >= this.maxFiles) return
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (isIgnored(entry.name)) continue
        const candidate = resolve(directory, entry.name)
        if (!isInside(root, candidate)) throw new Error("FDX_WORKSPACE_ESCAPE")
        if (candidate === this.stateFilePath) continue
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) { visit(candidate); continue }
        if (!entry.isFile()) continue
        if (statSync(candidate).size <= this.maxFileBytes) found.push(candidate)
      }
    }
    visit(root)
    return found.sort()
  }

  private clone(index: FdxWorkspaceSnapshot): FdxWorkspaceSnapshot {
    return { ...index, files: index.files.map(file => ({ ...file, symbols: [...file.symbols], dependencies: [...file.dependencies] })) }
  }

  private selectFiles(index: FdxWorkspaceSnapshot, paths?: readonly string[]): FdxIndexedFile[] {
    if (!paths?.length || paths.some(path => path === "." || path === "./")) return index.files
    const requested = this.relativePaths(index.workspace, paths)
    return index.files.filter(file => requested.some(path => file.path === path || file.path.startsWith(`${path}/`)))
  }

  private relativePaths(workspace: string, paths: readonly string[]): string[] {
    return paths.map(raw => {
      const candidate = resolve(workspace, raw)
      if (!isInside(workspace, candidate)) throw new Error("FDX_WORKSPACE_ESCAPE")
      return relative(workspace, candidate).replaceAll(sep, "/").replace(/\/$/, "")
    })
  }

  private load(): void {
    try {
      if (!existsSync(this.options.stateFile)) return
      const parsed = JSON.parse(readFileSync(this.options.stateFile, "utf8")) as unknown
      if (!Array.isArray(parsed)) return
      for (const value of parsed) {
        const index = value as FdxWorkspaceSnapshot
        if (!index || typeof index.workspaceId !== "string" || typeof index.workspace !== "string" || !Array.isArray(index.files)) continue
        if (this.state.size >= this.maxWorkspaces) break
        this.state.set(index.workspaceId, this.clone({ ...index, files: index.files.slice(0, this.maxFiles) }))
      }
    } catch { this.state.clear() }
  }

  private persist(): void {
    const values = [...this.state.values()].sort((a, b) => a.workspaceId.localeCompare(b.workspaceId)).slice(0, this.maxWorkspaces)
    const text = JSON.stringify(values)
    mkdirSync(dirname(this.options.stateFile), { recursive: true })
    const temporary = `${this.options.stateFile}.${process.pid}.tmp`
    writeFileSync(temporary, text, "utf8")
    renameSync(temporary, this.options.stateFile)
  }
}
