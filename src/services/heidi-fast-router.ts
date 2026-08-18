/**
 * HeidiFastRouter — Deterministic task classification for route-first execution.
 *
 * Classifies user tasks BEFORE expensive prompt construction or repository exploration.
 * Uses keyword/pattern matching and lightweight structural signals.
 *
 * Execution classes:
 *   FAST_DIRECT         — trivial local task; classify → inspect → edit → verify → done
 *   SPECIALIST          — single-domain task; delegate to specialist on turn 1
 *   PARALLEL_SPECIALISTS — multiple independent domains; launch concurrently
 *   STANDARD            — multi-file feature/refactor; scoped plan → execute → verify
 *   DEEP                — architecture migration, breaking redesign; full gates
 *
 * Domain subcategories (used within SPECIALIST/PARALLEL_SPECIALISTS):
 *   SECURITY | UI | RELEASE | DEBUG | DEVOPS
 *
 * Never consumes a full model reasoning turn for classification.
 */

export type ExecutionClass =
  | "FAST_DIRECT"
  | "SPECIALIST"
  | "PARALLEL_SPECIALISTS"
  | "STANDARD"
  | "DEEP"

export type SpecialistDomain =
  | "DEBUG"
  | "SECURITY"
  | "UI"
  | "DEVOPS"
  | "RELEASE"
  | "REVIEW"
  | "ARCHITECTURE"

export interface RouterDecision {
  /** Resolved execution class */
  executionClass: ExecutionClass
  /** For SPECIALIST/PARALLEL_SPECIALISTS: which specialist(s) to route to */
  specialists?: SpecialistDomain[]
  /** Suggested agent name(s) (canonical agent IDs from agent registry) */
  suggestedAgents?: string[]
  /** Why this classification was chosen */
  reason: string
  /** Confidence score 0–1; low confidence falls back to STANDARD */
  confidence: number
  /** Whether the decision was forced by an explicit user signal */
  forcedByExplicitSignal: boolean
}

// ─── Keyword patterns ────────────────────────────────────────────────────────

const FAST_DIRECT_PATTERNS: RegExp[] = [
  /fix (a )?typo/i,
  /rename (the )?(variable|function|method|class|type|interface|constant|file)/i,
  /change (the )?version (number|bump)/i,
  /bump version/i,
  /update (the )?(changelog|readme|comment)/i,
  /add (a )?(comment|docstring|jsdoc)/i,
  /fix (the )?(import|export)/i,
  /remove unused (import|variable|function|constant)/i,
  /small (config|configuration) (change|update|edit)/i,
  /single.file (bug|fix|edit|change)/i,
  /one.file (bug|fix|edit|change)/i,
  /fix (this )?one (line|function|error|bug)/i,
  /minor (tweak|fix|edit|adjustment|change)/i,
  /trivial (fix|change|edit)/i,
  /quick (fix|edit|change)/i,
  /update (the )?(config|configuration) (value|setting|option)/i,
]

const SECURITY_PATTERNS: RegExp[] = [
  /security audit/i,
  /security review/i,
  /vulnerability (scan|audit|assessment)/i,
  /threat model/i,
  /penetration test/i,
  /pentest/i,
  /auth(entication|orization) (review|audit|check)/i,
  /check for (secrets|credentials|api keys|sensitive data)/i,
  /owasp/i,
  /cve/i,
  /xss/i,
  /sql injection/i,
  /injection attack/i,
  /audit (the )?(security|permissions|access)/i,
]

const DEBUG_PATTERNS: RegExp[] = [
  /failing test/i,
  /test(s)? (fail|failing|broken|red)/i,
  /root cause/i,
  /debug (this|the|why)/i,
  /why (is|does|did) (this|it|the test)/i,
  /investigate (the )?(error|failure|crash|bug)/i,
  /diagnose/i,
  /exception (trace|stack)/i,
  /stack trace/i,
  /reproduce (the )?(bug|error|failure)/i,
  /cannot find module/i,
  /type error/i,
  /runtime (error|exception|crash)/i,
]

const UI_PATTERNS: RegExp[] = [
  /\bui\b.*(component|screen|page|layout|design)/i,
  /frontend.*(build|create|add|fix|update|component)/i,
  /react component/i,
  /vue component/i,
  /svelte component/i,
  /css.*(layout|styling|responsive|animation)/i,
  /landing page/i,
  /dashboard (ui|layout|design)/i,
  /design system/i,
  /tailwind/i,
  /shadcn/i,
  /responsive design/i,
  /user interface/i,
  /app screen/i,
]

const DEVOPS_PATTERNS: RegExp[] = [
  /ci\/cd/i,
  /deploy(ment|ing)/i,
  /kubernetes/i,
  /docker(file)?/i,
  /infrastructure/i,
  /terraform/i,
  /github actions/i,
  /workflow.yml/i,
  /pipeline (config|setup|update)/i,
  /helm chart/i,
  /container/i,
]

const RELEASE_PATTERNS: RegExp[] = [
  /release/i,
  /publish (to npm|package)/i,
  /npm publish/i,
  /changelog (update|prepare|generate)/i,
  /version bump (for release|preparation)/i,
  /prepare (a |the )?release/i,
  /cut (a )?release/i,
  /release (candidate|process|checklist)/i,
]

const PARALLEL_SIGNALS: RegExp[] = [
  /frontend.{0,30}(and|&|plus|\+).{0,30}backend/i,
  /backend.{0,30}(and|&|plus|\+).{0,30}frontend/i,
  /api.{0,30}(and|&|plus|\+).{0,30}(ui|client|frontend)/i,
  /simultaneously/i,
  /in parallel/i,
  /at the same time/i,
  /independent(ly)?/i,
  /two (separate|different|independent) (tasks|workstreams|changes)/i,
]

const DEEP_PATTERNS: RegExp[] = [
  /architecture (migration|redesign|overhaul)/i,
  /breaking (api|change|migration)/i,
  /full (refactor|rewrite|migration)/i,
  /migrate (from|to) (a )?new/i,
  /system.wide (change|refactor|redesign)/i,
  /major (refactor|redesign|overhaul)/i,
  /phase \d+ of/i,
  /release (qualification|gate)/i,
]

const STANDARD_PATTERNS: RegExp[] = [
  /add (a )?(new )?(feature|endpoint|route|module|service|command)/i,
  /implement/i,
  /create (a )?(new )?(class|module|service|api|interface)/i,
  /refactor/i,
  /multi.file (change|edit|update|refactor)/i,
  /several files/i,
  /across (multiple|several|many) files/i,
]

// ─── Classification logic ────────────────────────────────────────────────────

function matchesAny(input: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(input))
}

function classifySpecialistDomain(input: string): SpecialistDomain | null {
  if (matchesAny(input, SECURITY_PATTERNS)) return "SECURITY"
  if (matchesAny(input, DEBUG_PATTERNS)) return "DEBUG"
  if (matchesAny(input, DEVOPS_PATTERNS)) return "DEVOPS"
  if (matchesAny(input, RELEASE_PATTERNS)) return "RELEASE"
  if (matchesAny(input, UI_PATTERNS)) return "UI"
  return null
}

const SPECIALIST_AGENT_MAP: Record<SpecialistDomain, string> = {
  SECURITY: "security-auditor",
  DEBUG: "debug-specialist",
  UI: "frontend-coder",
  DEVOPS: "devops",
  RELEASE: "researcher",
  REVIEW: "reviewer",
  ARCHITECTURE: "architect",
}

/**
 * Classify a raw user prompt into an execution class.
 *
 * @param prompt Raw user-provided task description (lowercased internally).
 * @param hints  Optional structural hints from the runtime (e.g. affected file count estimate).
 */
export function classifyTask(
  prompt: string,
  hints?: {
    estimatedFileCount?: number
    hasExplicitDomainSignal?: boolean
    isResuming?: boolean
  }
): RouterDecision {
  const text = prompt.trim()
  const lc = text.toLowerCase()

  // ── FAST_DIRECT: trivial local task ──────────────────────────────────────
  const isFastDirect = matchesAny(text, FAST_DIRECT_PATTERNS)
  if (isFastDirect && !hints?.isResuming) {
    const estFiles = hints?.estimatedFileCount ?? 1
    if (estFiles <= 2) {
      return {
        executionClass: "FAST_DIRECT",
        reason: "Trivial local task matched fast-direct pattern with minimal file surface.",
        confidence: 0.9,
        forcedByExplicitSignal: false,
      }
    }
  }

  // ── DEEP: architectural migration ────────────────────────────────────────
  if (matchesAny(text, DEEP_PATTERNS)) {
    return {
      executionClass: "DEEP",
      reason: "Task matched architecture-level migration or breaking change pattern.",
      confidence: 0.85,
      forcedByExplicitSignal: false,
    }
  }

  // ── PARALLEL_SPECIALISTS: disjoint independent domains ───────────────────
  const isParallel = matchesAny(text, PARALLEL_SIGNALS)
  if (isParallel) {
    const domains: SpecialistDomain[] = []
    if (matchesAny(lc, UI_PATTERNS)) domains.push("UI")
    if (!domains.includes("UI")) {
      // Assume backend domain if frontend mentioned with something else
      if (lc.includes("backend") || lc.includes("api") || lc.includes("server")) domains.push("REVIEW")
    }
    if (domains.length < 2) domains.push("REVIEW")
    return {
      executionClass: "PARALLEL_SPECIALISTS",
      specialists: domains,
      suggestedAgents: domains.map(d => SPECIALIST_AGENT_MAP[d]),
      reason: "Task contains parallel domain signals (e.g. frontend + backend) with disjoint ownership.",
      confidence: 0.8,
      forcedByExplicitSignal: hints?.hasExplicitDomainSignal ?? false,
    }
  }

  // ── SPECIALIST: single-domain expert ─────────────────────────────────────
  const domain = classifySpecialistDomain(text)
  if (domain) {
    return {
      executionClass: "SPECIALIST",
      specialists: [domain],
      suggestedAgents: [SPECIALIST_AGENT_MAP[domain]],
      reason: `Task matched specialist domain '${domain}' — route to dedicated specialist on turn 1.`,
      confidence: 0.88,
      forcedByExplicitSignal: hints?.hasExplicitDomainSignal ?? false,
    }
  }

  // ── STANDARD: multi-file feature or refactor ──────────────────────────────
  const estFiles = hints?.estimatedFileCount ?? 0
  if (matchesAny(text, STANDARD_PATTERNS) || estFiles > 3) {
    return {
      executionClass: "STANDARD",
      reason: "Multi-file feature or refactor task — requires scoped planning and execution.",
      confidence: 0.75,
      forcedByExplicitSignal: false,
    }
  }

  // ── FAST_DIRECT: simple, short prompt with no strong signals ─────────────
  const wordCount = text.split(/\s+/).length
  if (wordCount <= 15 && estFiles <= 1) {
    return {
      executionClass: "FAST_DIRECT",
      reason: "Short prompt with no complex signals — default to FAST_DIRECT.",
      confidence: 0.65,
      forcedByExplicitSignal: false,
    }
  }

  // ── Default: STANDARD ─────────────────────────────────────────────────────
  return {
    executionClass: "STANDARD",
    reason: "No strong classification signal — falling back to STANDARD execution.",
    confidence: 0.6,
    forcedByExplicitSignal: false,
  }
}

/**
 * Return whether a given execution class should skip the specialist directory
 * in the Heidi prompt (lazy-loading strategy).
 */
export function shouldSkipSpecialistDirectory(cls: ExecutionClass): boolean {
  return cls === "FAST_DIRECT"
}

/**
 * Return the minimum set of specialist domains to surface for a given class.
 * Returns null if the full directory should be shown.
 */
export function getRequiredSpecialistDomains(decision: RouterDecision): SpecialistDomain[] | null {
  if (decision.executionClass === "FAST_DIRECT") return []
  if (decision.specialists && decision.specialists.length > 0) return decision.specialists
  return null  // full directory
}
