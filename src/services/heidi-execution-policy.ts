/**
 * Heidi Primary Execution Policy
 *
 * Defines execution strategies, justified delegation rules, the 6-stage
 * task lifecycle, pre-edit surface-area inspection, and bounded recovery.
 */

export type ExecutionStrategy =
  | "fast_direct"
  | "direct"
  | "explore_then_direct"
  | "planner_then_execute"
  | "debugger_root_cause"
  | "frontend_backend_parallel"
  | "audit_only"
  | "audit_after_change"

export const EXECUTION_STRATEGIES: readonly ExecutionStrategy[] = [
  "fast_direct",
  "direct",
  "explore_then_direct",
  "planner_then_execute",
  "debugger_root_cause",
  "frontend_backend_parallel",
  "audit_only",
  "audit_after_change",
] as const

export function isValidExecutionStrategy(val: unknown): val is ExecutionStrategy {
  return typeof val === "string" && (EXECUTION_STRATEGIES as readonly string[]).includes(val)
}

export type LifecycleStage =
  | "intake"
  | "route"
  | "context"
  | "execute"
  | "verify"
  | "complete"

export const LIFECYCLE_STAGES: readonly LifecycleStage[] = [
  "intake",
  "route",
  "context",
  "execute",
  "verify",
  "complete",
] as const

export interface DelegationContext {
  /** User explicitly named/requested a specialist agent */
  explicitUserRequest?: boolean
  /** Subtasks have independent, non-overlapping file ownership */
  independentOwnership?: boolean
  /** Requires specialized domain expertise (e.g. security-auditor, devops) */
  specialistDomainRequired?: boolean
  /** Task is a read-only audit or security review */
  auditOrSecurityReview?: boolean
  /** Direct repository discovery/inspection failed */
  directDiscoveryFailed?: boolean
  /** Change spans multiple technical domains requiring coordinated ownership */
  multiDomainSpanning?: boolean
}

export interface DelegationJustificationResult {
  justified: boolean
  reasons: string[]
}

/**
 * Determine if delegation to a specialist agent is justified.
 * Delegation is permitted ONLY when at least one justification condition is true.
 * Merely having a specialist agent available does NOT justify delegation.
 */
export function evaluateDelegationJustification(
  ctx: DelegationContext
): DelegationJustificationResult {
  const reasons: string[] = []

  if (ctx.explicitUserRequest) {
    reasons.push("User explicitly requested a specialist agent")
  }
  if (ctx.independentOwnership) {
    reasons.push("Work can run independently on non-overlapping file ownership")
  }
  if (ctx.specialistDomainRequired) {
    reasons.push("Task requires specialist domain expertise")
  }
  if (ctx.auditOrSecurityReview) {
    reasons.push("Read-only audit or security review requested")
  }
  if (ctx.directDiscoveryFailed) {
    reasons.push("Direct repository discovery failed")
  }
  if (ctx.multiDomainSpanning) {
    reasons.push("Change spans multiple technical domains requiring coordinated ownership")
  }

  return {
    justified: reasons.length > 0,
    reasons,
  }
}

export type ParallelExecutionStrategyChoice = "parallel" | "pipeline" | "sequential"

/**
 * Determine the optimal execution strategy for Heidi:
 * - Parallel: independent research questions, read-only architecture inspection,
 *   backend/frontend implementation with disjoint write scopes, independent test generation,
 *   security + review + mapping, multi-package analysis.
 * - Pipeline: several mechanical FDX reads/searches, simple deterministic multi-tool operations.
 * - Sequential: dependency chain, single-file surgical patch, migration -> code dependent on migration,
 *   integrated verification, unsafe overlapping writes.
 */
export function chooseParallelExecutionPolicy(task: {
  isSingleFilePatch?: boolean
  hasSequentialDependencies?: boolean
  hasOverlappingWriteScopes?: boolean
  isMechanicalToolOps?: boolean
  independentSubtasksCount?: number
  isReadonlyAudit?: boolean
}): ParallelExecutionStrategyChoice {
  if (task.isSingleFilePatch || task.hasSequentialDependencies || task.hasOverlappingWriteScopes) {
    return "sequential"
  }
  if (task.isMechanicalToolOps && (task.independentSubtasksCount ?? 0) <= 1) {
    return "pipeline"
  }
  if ((task.independentSubtasksCount ?? 0) >= 2 || task.isReadonlyAudit) {
    return "parallel"
  }
  return "sequential"
}

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, basename, extname, join, resolve, isAbsolute } from "node:path"

export interface SurfaceAreaCheckResult {
  dependents: string[]
  existingTests: string[]
  relatedConfig: string[]
  assumptions: string[]
  errorPaths: string[]
  readyForEdit: boolean
}

/**
 * Perform before-edit surface-area check.
 * Inspects callers/dependents, tests, config, and error paths before making changes.
 * Uses real filesystem inspection to provide meaningful data.
 */
export function performSurfaceAreaCheck(input: {
  targetFiles: string[]
  projectRoot?: string
  knownDependents?: string[]
  knownTests?: string[]
  knownConfig?: string[]
  assumptions?: string[]
  errorPaths?: string[]
}): SurfaceAreaCheckResult {
  const root = input.projectRoot ? resolve(input.projectRoot) : process.cwd()
  const resolvedTargets = input.targetFiles.map(f => isAbsolute(f) ? resolve(f) : resolve(root, f))

  const dependents = discoverActualDependents(resolvedTargets)
  const existingTests = discoverActualTests(resolvedTargets, root)
  const relatedConfig = discoverRelatedConfig(resolvedTargets, root)
  const assumptions = input.assumptions ?? deriveAssumptions(resolvedTargets)
  const errorPaths = input.errorPaths ?? discoverErrorPaths(resolvedTargets)

  return {
    dependents,
    existingTests,
    relatedConfig,
    assumptions,
    errorPaths,
    readyForEdit: resolvedTargets.length > 0,
  }
}

/**
 * Discover actual dependent files by looking for imports/references to target files.
 */
function discoverActualDependents(targetFiles: string[]): string[] {
  const results: string[] = []
  for (const file of targetFiles) {
    try {
      if (!existsSync(file)) continue
      const name = basename(file, extname(file))
      const dir = dirname(file)

      const siblings = readdirSync(dir).filter((f: string) => f.endsWith(".ts") || f.endsWith(".tsx"))
      for (const sibling of siblings) {
        if (sibling === basename(file)) continue
        try {
          const content = readFileSync(join(dir, sibling), "utf-8")
          if (content.includes(`./${name}`) || content.includes(`"${name}"`) || content.includes(`'${name}'`)) {
            results.push(join(dir, sibling))
          }
        } catch { /* skip unreadable */ }
      }

      const indexFiles = ["index.ts", "index.tsx", "index.js"]
      for (const idx of indexFiles) {
        const idxPath = join(dir, idx)
        if (idxPath !== file && existsSync(idxPath)) {
          try {
            const content = readFileSync(idxPath, "utf-8")
            if (content.includes(`./${name}`) || content.includes(`"${name}"`)) {
              results.push(idxPath)
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* silent fallback */ }
  }
  return results
}

/**
 * Discover actual test files related to target files.
 */
function discoverActualTests(targetFiles: string[], projectRoot: string): string[] {
  const results: string[] = []
  for (const file of targetFiles) {
    try {
      const dir = dirname(file)
      const name = basename(file, extname(file))

      const testPatterns = [
        `${name}.test.ts`, `${name}.test.tsx`, `${name}.spec.ts`,
        `${name}.test.js`, `${name}.spec.js`,
        `${name}.test.mjs`, `${name}.spec.mjs`,
      ]

      for (const pattern of testPatterns) {
        const testPath = join(dir, pattern)
        if (existsSync(testPath)) results.push(testPath)
      }

      const testsDir = join(dir, "__tests__")
      if (existsSync(testsDir)) {
        const testFiles = readdirSync(testsDir)
        for (const tf of testFiles) {
          if (tf.includes(name) && (tf.endsWith(".test.ts") || tf.endsWith(".spec.ts") || tf.endsWith(".test.js"))) {
            results.push(join(testsDir, tf))
          }
        }
      }

      const rootTests = join(projectRoot, "tests")
      if (existsSync(rootTests)) {
        const rootFiles = readdirSync(rootTests)
        for (const rf of rootFiles) {
          if (rf.includes(name) && (rf.endsWith(".test.ts") || rf.endsWith(".spec.ts"))) {
            results.push(join(rootTests, rf))
          }
        }
      }
    } catch { /* silent fallback */ }
  }
  return results
}

/**
 * Discover related configuration files.
 */
export function discoverRelatedConfig(targetFiles: string[], explicitProjectRoot?: string): string[] {
  const configPatterns = [
    "package.json", "tsconfig.json", "tsconfig.build.json",
    ".flowdeck.json", ".flowdeck.jsonc", ".gitignore",
    "Cargo.toml", "Cargo.lock", "mkdocs.yml",
    ".eslintrc.js", ".eslintrc.json", ".prettierrc",
    "vitest.config.ts", "vitest.config.js", "jest.config.ts",
  ]

  let root = explicitProjectRoot ? resolve(explicitProjectRoot) : resolve(process.cwd())

  if (!explicitProjectRoot) {
    for (const file of targetFiles) {
      if (file) {
        let current = resolve(file)
        try {
          if (existsSync(current) && statSync(current).isFile()) {
            current = dirname(current)
          }
        } catch {
          current = dirname(current)
        }
        let found = false
        for (let i = 0; i < 15; i++) {
          if (
            existsSync(join(current, ".flowdeck.json")) ||
            existsSync(join(current, ".flowdeck.jsonc")) ||
            existsSync(join(current, "package.json")) ||
            existsSync(join(current, ".git"))
          ) {
            root = current
            found = true
            break
          }
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        if (found) break
      }
    }
  }

  const results: string[] = []
  for (const pattern of configPatterns) {
    try {
      const configPath = join(root, pattern)
      if (existsSync(configPath)) results.push(configPath)
    } catch { /* skip */ }
  }
  return results
}

/**
 * Derive assumptions from file types being modified.
 */
function deriveAssumptions(targetFiles: string[]): string[] {
  const assumptions: string[] = []
  for (const file of targetFiles) {
    if (file.endsWith(".ts") || file.endsWith(".tsx")) {
      assumptions.push("TypeScript types pass build step")
    }
    if (file.includes("agent") || file.includes("skill")) {
      assumptions.push("YAML frontmatter schema valid")
    }
    if (file.includes("config") || file.endsWith(".json")) {
      assumptions.push("Config schema backwards-compatible")
    }
  }
  if (assumptions.length === 0) {
    assumptions.push("Target files exist and are readable")
  }
  assumptions.push("No side effects on unrelated modules")
  return assumptions
}

/**
 * Discover error paths by checking for error handling patterns in similar files.
 */
function discoverErrorPaths(targetFiles: string[]): string[] {
  const errorPaths: string[] = []
  for (const file of targetFiles) {
    try {
      if (!existsSync(file)) continue
      const content = readFileSync(file, "utf-8")
      if (content.includes("throw ") && !errorPaths.includes("Error paths from existing code")) {
        errorPaths.push("Error paths from existing code")
      }
      if (content.includes("catch") && !errorPaths.includes("Exception handling exists")) {
        errorPaths.push("Exception handling exists")
      }
      if (content.includes("undefined") || content.includes("null"))
        if (!errorPaths.includes("Null/undefined checks needed")) errorPaths.push("Null/undefined checks needed")
    } catch { /* skip */ }
  }
  return errorPaths
}

export interface FailureRecoveryState {
  errorKey: string
  attempts: number
  action: "targeted_diagnosis" | "change_hypothesis" | "circuit_breaker_block"
  message: string
}

/**
 * Bounded Recovery Tracker.
 * 1st failure -> targeted diagnosis
 * 2nd failure -> change hypothesis / strategy
 * 3rd failure -> circuit breaker block and exact report
 * Normal implementation tasks receive at most 1 automatic repair cycle.
 */
export class BoundedRecoveryTracker {
  private failureCounts: Map<string, number> = new Map()

  recordFailure(errorKey: string): FailureRecoveryState {
    const count = (this.failureCounts.get(errorKey) ?? 0) + 1
    this.failureCounts.set(errorKey, count)

    if (count === 1) {
      return {
        errorKey,
        attempts: 1,
        action: "targeted_diagnosis",
        message: `[Recovery 1/3] Failure detected for "${errorKey}". Performing targeted diagnosis on root cause.`,
      }
    }

    if (count === 2) {
      return {
        errorKey,
        attempts: 2,
        action: "change_hypothesis",
        message: `[Recovery 2/3] Equivalent failure repeated for "${errorKey}". Changing repair hypothesis or strategy.`,
      }
    }

    return {
      errorKey,
      attempts: count,
      action: "circuit_breaker_block",
      message: `[Recovery 3/3 Circuit Breaker] Task failed ${count} times on "${errorKey}". Stopping automatic retries and reporting exact root cause to user.`,
    }
  }

  getFailureCount(errorKey: string): number {
    return this.failureCounts.get(errorKey) ?? 0
  }

  reset(errorKey?: string): void {
    if (errorKey) {
      this.failureCounts.delete(errorKey)
    } else {
      this.failureCounts.clear()
    }
  }
}
