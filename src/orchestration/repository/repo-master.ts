import { createHash, randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { FdxWorkspaceIndex, type FdxWorkspaceSnapshot } from "../../services/fdx-index"
import { getRepositoryContext } from "../../services/repository-hot-context"
import type { ExecutionMode, RouterDecision, SpecialistDomain } from "../../services/heidi-fast-router"

export const REPO_MASTER_STATE_VERSION = "1.0.0"
const MAX_CACHE_ENTRIES = 64
const MAX_RELEVANT_FILES = 24
const MAX_DEPENDENCY_EDGES = 48
const MAX_TESTS = 12
const MAX_RELEVANT_PACKAGES = 24
const MAX_SCOPE = 12
const MAX_STRING_LENGTH = 512

export type RepoMasterConsultationRequirement = "none" | "optional" | "required"

export interface RepoMasterSourceState {
  repositoryId: string
  root: string
  headSha: string | null
  branch: string | null
  dirtyFingerprint: string
  packageFingerprint: string
  configFingerprint: string
  fingerprint: string
}

export interface RepoMasterRequest {
  runId: string
  goal: string
  executionMode: ExecutionMode
  decision: Pick<RouterDecision, "executionClass" | "reasonCode" | "specialists" | "suggestedAgents">
}

export interface RepoMasterDependencyEdge {
  from: string
  to: string
}

/**
 * Structured repository evidence only. It intentionally contains no prompt,
 * model, secret, hidden reasoning, native session, verification, or completion state.
 */
export interface RepoMasterAdvice {
  version: typeof REPO_MASTER_STATE_VERSION
  requestId: string
  runId: string
  repository: RepoMasterSourceState
  executionMode: ExecutionMode
  scope: string[]
  relevantPackages: string[]
  relevantFiles: string[]
  dependencyEdges: RepoMasterDependencyEdge[]
  likelyTests: string[]
  architecturalConstraints: string[]
  riskAreas: string[]
  suggestedSpecialistCapabilities: SpecialistDomain[]
  confidence: number
  evidenceSources: string[]
  generatedAt: string
}

export function parseRepoMasterAdvice(value: string): RepoMasterAdvice | null {
  try {
    if (value.length > 64_000) return null
    const parsed = JSON.parse(value) as Partial<RepoMasterAdvice>
    const boundedString = (item: unknown, max = MAX_STRING_LENGTH): item is string => typeof item === "string" && item.length > 0 && item.length <= max
    const fingerprint = (item: unknown): item is string => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)
    if (!parsed || parsed.version !== REPO_MASTER_STATE_VERSION || !fingerprint(parsed.requestId) || !boundedString(parsed.runId, 256)) return null
    if (!parsed.repository || !fingerprint(parsed.repository.repositoryId) || !boundedString(parsed.repository.root, 4_096) || (parsed.repository.headSha !== null && !/^[a-f0-9]{40}$/.test(parsed.repository.headSha ?? "")) || (parsed.repository.branch !== null && !boundedString(parsed.repository.branch, 256)) || !fingerprint(parsed.repository.dirtyFingerprint) || !fingerprint(parsed.repository.packageFingerprint) || !fingerprint(parsed.repository.configFingerprint) || !fingerprint(parsed.repository.fingerprint)) return null
    if (parsed.executionMode !== "DIRECT" && parsed.executionMode !== "SINGLE_SPECIALIST" && parsed.executionMode !== "MULTI_SPECIALIST") return null
    if (!Array.isArray(parsed.scope) || !Array.isArray(parsed.relevantFiles) || !Array.isArray(parsed.relevantPackages) || !Array.isArray(parsed.dependencyEdges) || !Array.isArray(parsed.likelyTests) || !Array.isArray(parsed.architecturalConstraints) || !Array.isArray(parsed.riskAreas) || !Array.isArray(parsed.suggestedSpecialistCapabilities) || !Array.isArray(parsed.evidenceSources)) return null
    if (parsed.scope.length > MAX_SCOPE || parsed.relevantFiles.length > MAX_RELEVANT_FILES || parsed.relevantPackages.length > MAX_RELEVANT_PACKAGES || parsed.dependencyEdges.length > MAX_DEPENDENCY_EDGES || parsed.likelyTests.length > MAX_TESTS || parsed.architecturalConstraints.length > 8 || parsed.riskAreas.length > 8 || parsed.suggestedSpecialistCapabilities.length > 8 || parsed.evidenceSources.length > 8) return null
    const boundedStrings = (items: unknown[]): boolean => items.every(item => typeof item === "string" && item.length <= MAX_STRING_LENGTH)
    if (!boundedStrings(parsed.scope) || !boundedStrings(parsed.relevantFiles) || !boundedStrings(parsed.relevantPackages) || !boundedStrings(parsed.likelyTests) || !boundedStrings(parsed.architecturalConstraints) || !boundedStrings(parsed.riskAreas) || !boundedStrings(parsed.evidenceSources)) return null
    if (!parsed.dependencyEdges.every(item => item && typeof item.from === "string" && item.from.length <= MAX_STRING_LENGTH && typeof item.to === "string" && item.to.length <= MAX_STRING_LENGTH)) return null
    if (!parsed.suggestedSpecialistCapabilities.every(item => ["DEBUG", "SECURITY", "UI", "BACKEND", "DEVOPS", "RELEASE", "REVIEW", "ARCHITECTURE"].includes(item))) return null
    if (typeof parsed.confidence !== "number" || !Number.isFinite(parsed.confidence) || parsed.confidence < 0 || parsed.confidence > 1 || !boundedString(parsed.generatedAt, 64) || Number.isNaN(Date.parse(parsed.generatedAt))) return null
    return parsed as RepoMasterAdvice
  } catch {
    return null
  }
}

export interface RepoMasterDiagnostics {
  repository: RepoMasterSourceState
  fresh: boolean
  lastRefreshAt?: string
  indexAgeMs?: number
  relevantScopeCount: number
  cacheHits: number
  cacheMisses: number
  refreshes: number
  corruptStateRecovered: boolean
}

/**
 * Durable shared metadata only. Run-specific advice is deliberately excluded and
 * persists solely through canonical RoutingDecision evidence for its owning Run.
 */
interface PersistedRepoMasterState {
  version: typeof REPO_MASTER_STATE_VERSION
  repositoryId: string
  fingerprint: string
  lastRefreshAt: string
  indexUpdatedAt: string
}

interface RuntimeRepoMasterState extends PersistedRepoMasterState {
  advice: RepoMasterAdvice[]
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function digest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex")
}

function safeGit(root: string, args: string[]): string | null {
  try {
    const value = execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    }).trim()
    return value
  } catch {
    return null
  }
}

function canonicalRoot(directory: string): string {
  const root = resolve(directory)
  return existsSync(root) ? realpathSync(root) : root
}

function checksumFiles(root: string, relativePaths: readonly string[]): string {
  return digest(relativePaths.map(path => {
    const candidate = join(root, path)
    if (!existsSync(candidate)) return { path, absent: true }
    try {
      const stats = statSync(candidate)
      return { path, size: stats.size, mtimeMs: stats.mtimeMs, content: stats.size <= 256_000 ? createHash("sha256").update(readFileSync(candidate)).digest("hex") : undefined }
    } catch {
      return { path, unreadable: true }
    }
  }))
}

function normalisePath(root: string, candidate: string): string {
  const value = relative(root, candidate).replaceAll(sep, "/")
  return value && !value.startsWith("../") && value !== ".." ? value : "."
}

function boundedTerms(goal: string): string[] {
  const stopWords = new Set(["the", "and", "for", "with", "from", "this", "that", "into", "should", "would", "about", "after", "before", "code", "repository"])
  return [...new Set(goal.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g)?.filter(term => !stopWords.has(term)) ?? [])].sort().slice(0, 16)
}

function inferCapabilities(goal: string, decision: RepoMasterRequest["decision"]): SpecialistDomain[] {
  const text = `${goal} ${decision.reasonCode}`.toLowerCase()
  const result = new Set<SpecialistDomain>(decision.specialists ?? [])
  if (/security|auth|permission|secret|credential|vulnerab/.test(text)) result.add("SECURITY")
  if (/architecture|migration|redesign|cross[- ]package|dependency/.test(text)) result.add("ARCHITECTURE")
  if (/review|audit|regression/.test(text)) result.add("REVIEW")
  if (/database|api|backend|server|service/.test(text)) result.add("BACKEND")
  if (/frontend|ui|component|browser/.test(text)) result.add("UI")
  if (/deploy|ci|workflow|infra|docker/.test(text)) result.add("DEVOPS")
  return [...result].sort()
}

function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)|\.test\.[cm]?[jt]sx?$|\.spec\.[cm]?[jt]sx?$/i.test(path)
}

function matchesTerm(haystack: string, term: string): boolean {
  if (haystack.includes(term)) return true
  const prefix = term.slice(0, 4)
  return prefix.length === 4 && haystack.includes(prefix)
}

function isRuntimeMetadataPath(path: string): boolean {
  const value = path.trim().replaceAll("\\", "/").replace(/^"|"$/g, "").replace(/\/+$/, "")
  // Ignore only Repo Master's own atomic metadata and its dedicated FDX state.
  // User-authored `.flowdeck/*` content remains a meaningful repository change.
  return value === ".flowdeck/repo-master.json" ||
    value.startsWith(".flowdeck/repo-master.json.") ||
    value === ".flowdeck/repo-master-fdx-index.json" ||
    value.startsWith(".flowdeck/repo-master-fdx-index.json.")
}

function isPackageManifest(path: string): boolean {
  return /(^|\/)(package\.json|Cargo\.toml|pnpm-workspace\.yaml|turbo\.json)$/i.test(path)
}

/** Consult only when current repository intelligence materially improves a non-direct route. */
export function repoMasterConsultationRequirement(input: Pick<RepoMasterRequest, "goal" | "executionMode" | "decision">): RepoMasterConsultationRequirement {
  if (input.executionMode === "DIRECT") return "none"
  const text = `${input.goal} ${input.decision.reasonCode}`.toLowerCase()
  if (input.executionMode === "MULTI_SPECIALIST") return "required"
  if (/migration|architecture|cross[- ]package|dependency|repository[- ]wide|workspace|unknown ownership|blast radius/.test(text)) return "required"
  if (input.executionMode === "SINGLE_SPECIALIST" && /debug|refactor|investigat|backend|security|ui|devops/.test(text)) return "optional"
  return "none"
}

/**
 * Repo Master is read-only advisory repository intelligence. It wraps the existing
 * FDX resident index instead of building a second code-indexing or execution engine.
 */
export class RepoMaster {
  private readonly root: string
  private readonly stateFile: string
  private readonly index: FdxWorkspaceIndex
  private state: RuntimeRepoMasterState | null = null
  private cacheHits = 0
  private cacheMisses = 0
  private refreshes = 0
  private corruptStateRecovered = false

  constructor(directory: string, options?: { stateFile?: string; index?: FdxWorkspaceIndex }) {
    this.root = canonicalRoot(directory)
    this.stateFile = resolve(options?.stateFile ?? join(this.root, ".flowdeck", "repo-master.json"))
    this.index = options?.index ?? new FdxWorkspaceIndex({ stateFile: join(this.root, ".flowdeck", "repo-master-fdx-index.json") })
    this.load()
  }

  sourceState(): RepoMasterSourceState {
    const root = this.root
    const hotContext = getRepositoryContext(root)
    const repositoryId = digest({ root })
    const headSha = safeGit(root, ["rev-parse", "HEAD"]) ?? hotContext.headSha
    const branch = safeGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? hotContext.branch
    const dirtyRaw = safeGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]) ?? "non-git"
    const dirty = dirtyRaw === "non-git" ? dirtyRaw : dirtyRaw.split("\n").filter(line => {
      const paths = line.slice(3).split(" -> ")
      return !paths.every(isRuntimeMetadataPath)
    }).sort().join("\n")
    const packageFingerprint = checksumFiles(root, ["package.json", "package-lock.json", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "Cargo.toml", "pnpm-workspace.yaml", "turbo.json"])
    const configFingerprint = checksumFiles(root, [".flowdeck.json", ".flowdeck.jsonc", ".opencode/flowdeck.json", ".opencode/flowdeck.jsonc", "opencode.json"])
    const dirtyFingerprint = digest(dirty.split("\n").filter(Boolean).sort())
    return {
      repositoryId,
      root,
      headSha,
      branch,
      dirtyFingerprint,
      packageFingerprint,
      configFingerprint,
      fingerprint: digest({ repositoryId, headSha, branch, dirtyFingerprint, packageFingerprint, configFingerprint }),
    }
  }

  diagnostics(): RepoMasterDiagnostics {
    const repository = this.sourceState()
    const fresh = Boolean(this.state && this.state.repositoryId === repository.repositoryId && this.state.fingerprint === repository.fingerprint)
    const indexAgeMs = this.state ? Math.max(0, Date.now() - Date.parse(this.state.indexUpdatedAt)) : undefined
    const relevantScopeCount = this.state?.advice.reduce((count, advice) => count + advice.relevantFiles.length, 0) ?? 0
    return {
      repository,
      fresh,
      lastRefreshAt: this.state?.lastRefreshAt,
      indexAgeMs,
      relevantScopeCount,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      refreshes: this.refreshes,
      corruptStateRecovered: this.corruptStateRecovered,
    }
  }

  invalidate(changedPaths?: readonly string[]): void {
    this.index.invalidate(this.root, changedPaths)
    this.state = null
    this.persistEmpty()
  }

  isAdviceFresh(advice: RepoMasterAdvice | null | undefined): advice is RepoMasterAdvice {
    if (!advice || advice.version !== REPO_MASTER_STATE_VERSION) return false
    const repository = this.sourceState()
    return advice.repository.repositoryId === repository.repositoryId && advice.repository.fingerprint === repository.fingerprint
  }

  consult(request: RepoMasterRequest): { advice: RepoMasterAdvice; cacheHit: boolean; refreshed: boolean } {
    if (!request.runId.trim()) throw new Error("REPO_MASTER_RUN_REQUIRED")
    if (!request.goal.trim()) throw new Error("REPO_MASTER_GOAL_REQUIRED")
    const repository = this.sourceState()
    const requestId = digest({ version: REPO_MASTER_STATE_VERSION, runId: request.runId, goal: request.goal.trim(), executionMode: request.executionMode, decision: request.decision, repositoryFingerprint: repository.fingerprint })
    const freshState = this.state && this.state.repositoryId === repository.repositoryId && this.state.fingerprint === repository.fingerprint
    const cached = freshState && this.state ? this.state.advice.find(advice => advice.requestId === requestId && this.isAdviceFresh(advice)) : undefined
    if (cached) {
      this.cacheHits += 1
      return { advice: structuredClone(cached), cacheHit: true, refreshed: false }
    }

    this.cacheMisses += 1
    const snapshot = freshState ? this.index.ensureInitialized(this.root) : this.refresh(repository)
    const advice = this.buildAdvice(request, repository, requestId, snapshot)
    const prior = freshState ? this.state?.advice ?? [] : []
    this.state = {
      version: REPO_MASTER_STATE_VERSION,
      repositoryId: repository.repositoryId,
      fingerprint: repository.fingerprint,
      lastRefreshAt: this.state?.lastRefreshAt ?? new Date().toISOString(),
      indexUpdatedAt: snapshot.updatedAt,
      advice: [...prior.filter(item => item.requestId !== advice.requestId), advice].slice(-MAX_CACHE_ENTRIES),
    }
    this.persist()
    return { advice: structuredClone(advice), cacheHit: false, refreshed: !freshState }
  }

  private refresh(repository: RepoMasterSourceState): FdxWorkspaceSnapshot {
    const snapshot = this.index.refresh(this.root)
    this.refreshes += 1
    this.state = {
      version: REPO_MASTER_STATE_VERSION,
      repositoryId: repository.repositoryId,
      fingerprint: repository.fingerprint,
      lastRefreshAt: new Date().toISOString(),
      indexUpdatedAt: snapshot.updatedAt,
      advice: [],
    }
    this.persist()
    return snapshot
  }

  private buildAdvice(request: RepoMasterRequest, repository: RepoMasterSourceState, requestId: string, snapshot: FdxWorkspaceSnapshot): RepoMasterAdvice {
    const terms = boundedTerms(request.goal)
    const ranked = snapshot.files.map(file => {
      const haystack = `${file.path} ${file.symbols.join(" ")} ${file.dependencies.join(" ")}`.toLowerCase()
      const score = terms.reduce((sum, term) => sum + (matchesTerm(haystack, term) ? 1 : 0), 0)
      return { file, score }
    }).sort((a, b) => b.score - a.score || a.file.path.localeCompare(b.file.path))
    const relevant = ranked.filter(item => item.score > 0).slice(0, MAX_RELEVANT_FILES).map(item => item.file)
    const selected = relevant.length > 0 ? relevant : ranked.slice(0, Math.min(8, ranked.length)).map(item => item.file)
    const relevantFiles = selected.map(file => file.path).sort()
    const dependencyEdges = selected.flatMap(file => file.dependencies.map(to => ({ from: file.path, to }))).sort((a, b) => `${a.from}:${a.to}`.localeCompare(`${b.from}:${b.to}`)).slice(0, MAX_DEPENDENCY_EDGES)
    const likelyTests = snapshot.files.filter(file => isTestPath(file.path)).map(file => file.path).filter(path => {
      const needle = path.toLowerCase()
      return terms.some(term => matchesTerm(needle, term)) || relevantFiles.some(source => source.split("/").at(-1)?.split(".")[0] && needle.includes(source.split("/").at(-1)!.split(".")[0]))
    }).sort().slice(0, MAX_TESTS)
    const relevantPackages = snapshot.files.filter(file => isPackageManifest(file.path)).map(file => normalisePath(this.root, join(this.root, file.path))).sort()
    const architecturalConstraints = [
      ...(relevantFiles.some(path => path.startsWith("src/orchestration/") || path.startsWith("src/runtime/")) ? ["Preserve durable Run, VerificationService, and CompletionPolicy authority boundaries."] : []),
      ...(relevantFiles.some(path => path.startsWith("crates/fdx/")) ? ["Machine-consumed Git output must remain explicitly colour-safe."] : []),
      "Repo Master advice is advisory; existing routing and SpecialistPlan policies remain authoritative.",
    ]
    const riskAreas = [
      ...(repository.dirtyFingerprint !== digest([]) ? ["Working tree has meaningful state that binds this advice."] : []),
      ...(relevantFiles.some(isPackageManifest) ? ["Package/dependency manifest changes require refresh before reuse."] : []),
      ...(dependencyEdges.length > 0 ? ["Dependency edges may expand the verification blast radius."] : []),
    ]
    const suggestedSpecialistCapabilities = inferCapabilities(request.goal, request.decision)
    const confidence = Math.min(1, Math.max(0.1, selected.length === 0 ? 0.1 : 0.4 + Math.min(0.5, relevant.length / 20)))
    return {
      version: REPO_MASTER_STATE_VERSION,
      requestId,
      runId: request.runId,
      repository,
      executionMode: request.executionMode,
      scope: relevantFiles.slice(0, MAX_SCOPE),
      relevantPackages: relevantPackages.slice(0, MAX_RELEVANT_PACKAGES),
      relevantFiles,
      dependencyEdges,
      likelyTests,
      architecturalConstraints,
      riskAreas,
      suggestedSpecialistCapabilities,
      confidence,
      evidenceSources: ["fdx_workspace_index", "repository_hot_context", "repository_source_fingerprint"],
      generatedAt: new Date().toISOString(),
    }
  }

  private load(): void {
    if (!existsSync(this.stateFile)) return
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as PersistedRepoMasterState
      if (!parsed || parsed.version !== REPO_MASTER_STATE_VERSION) throw new Error("REPO_MASTER_STATE_INVALID")
      if ((parsed as { invalidated?: unknown }).invalidated === true) return
      if (typeof parsed.repositoryId !== "string" || typeof parsed.fingerprint !== "string" || typeof parsed.lastRefreshAt !== "string" || typeof parsed.indexUpdatedAt !== "string") throw new Error("REPO_MASTER_STATE_INVALID")
      // A nonempty persisted advice array would leak run-specific evidence into a shared
      // repository cache. Treat it as corrupt rather than silently reusing it.
      const legacyAdvice = (parsed as { advice?: unknown }).advice
      if (Array.isArray(legacyAdvice) && legacyAdvice.length > 0) throw new Error("REPO_MASTER_RUN_ADVICE_PERSISTED")
      const current = this.sourceState()
      if (parsed.repositoryId !== current.repositoryId) throw new Error("REPO_MASTER_REPOSITORY_IDENTITY_MISMATCH")
      this.state = { ...parsed, advice: [] }
    } catch {
      this.state = null
      this.corruptStateRecovered = true
    }
  }

  private persistEmpty(): void {
    try {
      if (existsSync(this.stateFile)) {
        const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`
        writeFileSync(temporary, JSON.stringify({ version: REPO_MASTER_STATE_VERSION, invalidatedAt: new Date().toISOString() }), "utf8")
        renameSync(temporary, this.stateFile)
      }
    } catch {
      // Cache invalidation must never become execution authority.
    }
  }

  private persist(): void {
    if (!this.state) return
    mkdirSync(dirname(this.stateFile), { recursive: true })
    const temporary = `${this.stateFile}.${process.pid}.${randomUUID()}.tmp`
    const { advice: _runSpecificAdvice, ...shared } = this.state
    writeFileSync(temporary, JSON.stringify(shared), "utf8")
    renameSync(temporary, this.stateFile)
  }
}
