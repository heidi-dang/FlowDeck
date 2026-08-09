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

  symbols(workspace: string, query: string, paths?: readonly string[]): Array<{ path: string; symbol: string }> {
    const index = this.refresh(workspace)
    const needle = query.trim().toLowerCase()
    return this.selectFiles(index, paths).flatMap(file => file.symbols.filter(symbol => !needle || symbol.toLowerCase().includes(needle)).map(symbol => ({ path: file.path, symbol }))).slice(0, 500)
  }

  outline(workspace: string, paths?: readonly string[]): Array<{ path: string; symbols: string[] }> {
    const index = this.refresh(workspace)
    return this.selectFiles(index, paths).map(file => ({ path: file.path, symbols: [...file.symbols] }))
  }

  impact(workspace: string, paths: readonly string[]): FdxImpactSnapshot {
    const index = this.refresh(workspace)
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
