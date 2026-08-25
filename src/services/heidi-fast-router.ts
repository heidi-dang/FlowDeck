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
 *   SECURITY | UI | BACKEND | DEVOPS | RELEASE | DEBUG | REVIEW | ARCHITECTURE
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
  | "BACKEND"
  | "DEVOPS"
  | "RELEASE"
  | "REVIEW"
  | "ARCHITECTURE"

/** Semantic orchestration depth, intentionally mapped onto existing execution classes. */
export type ExecutionMode = "DIRECT" | "SINGLE_SPECIALIST" | "MULTI_SPECIALIST"

export function executionModeForClass(executionClass: ExecutionClass): ExecutionMode {
  switch (executionClass) {
    case "SPECIALIST":
      return "SINGLE_SPECIALIST"
    case "PARALLEL_SPECIALISTS":
      return "MULTI_SPECIALIST"
    case "FAST_DIRECT":
    case "STANDARD":
      return "DIRECT"
    case "DEEP":
      return "MULTI_SPECIALIST"
  }
}

import { evaluateCodeModeEligibility } from "./heidi-code-mode-evaluator"
import type { CodeModeTelemetry } from "./heidi-code-mode-policy"

export interface RouterDecision {
  /** Resolved execution class */
  executionClass: ExecutionClass
  /** Explicit semantic orchestration depth mapped from the compatibility execution class. Legacy decisions may omit it and are derived at the persistence boundary. */
  executionMode?: ExecutionMode
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
  /** Absolutely minimal deterministic reason code used for telemetry (no chain-of-thought). */
  reasonCode: string
  /** Whether the task involves MCP tool composition */
  mcpCompositionCandidate?: boolean
  codeModeRejectedReason?: string
  codeModeTelemetry?: CodeModeTelemetry
}

// ─── Keyword patterns ────────────────────────────────────────────────────────

const SIMPLE_DIRECT_QUERY_PATTERNS: RegExp[] = [
  /\b(what|which|show|tell me|explain|read)\b.{0,180}\b(version|configured|configuration|setting|function|file|value|package)\b/i,
  /\b(read|inspect)\b.{0,120}\b(explain|summarize|describe)\b/i,
]

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
  /\b(react|vue|svelte|angular|next|nuxt)\b.{0,40}\b(ui|frontend|interface|component|screen)\b/i,
  /^\s*(build|create|implement|add|fix|update)\s+(the\s+)?(react|vue|svelte)\s+(ui|frontend)/i,
]

const BACKEND_PATTERNS: RegExp[] = [
  /\bbackend\b/i,
  /server.side/i,
  /api (endpoint|route|implementation|server)/i,
  /rest (api|endpoint|service)/i,
  /graphql (resolver|schema|api)/i,
  /database (schema|model|migration|query|repository|store)/i,
  /business logic/i,
  /service layer/i,
  /microservice/i,
  /(implement|build|add) (the )?(api|endpoint|route|service|handler|middleware|controller)/i,
  /(fix|update) (the )?(api|endpoint|route|service|handler|middleware|controller)/i,
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
  /chore: (bump|release)/i,
]

const REVIEW_PATTERNS: RegExp[] = [
  /review (the |this |my |our )?(code|changes|pr|pull request|diff|implementation)/i,
  /code review/i,
  /review request/i,
  /review (and |then )?(approve|comment|merge)/i,
  /look over (my |the |this )?(code|changes|diff)/i,
]

const ARCHITECTURE_PATTERNS: RegExp[] = [
  /architecture (investigation|exploration|review|design|analysis)/i,
  /how (does|do) (the |our |these )?.* fit together/i,
  /system design/i,
  /design (the |our )?architecture/i,
  /architectural (analysis|assessment|design)/i,
  /component (diagram|boundaries|contract)/i,
  /technical (design|architecture) (document|doc|proposal)/i,
]

const PARALLEL_SIGNALS: RegExp[] = [
  /frontend.{0,40}(and|&|plus|\+).{0,40}backend/i,
  /backend.{0,40}(and|&|plus|\+).{0,40}frontend/i,
  /api.{0,30}(and|&|plus|\+).{0,30}(ui|client|frontend)/i,
  /(ui|client|frontend).{0,30}(and|&|plus|\+).{0,30}(api|backend|server)/i,
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
  /migrate.{0,80}(application|system|architecture|framework)/i,
  /system.wide (change|refactor|redesign)/i,
  /major (refactor|redesign|overhaul)/i,
  /phase \d+ of/i,
  /release (qualification|gate)/i,
]

const EXPLICIT_DIRECT_PATTERNS: RegExp[] = [
  /\b(do|handle|perform|solve) (this )?(yourself|directly)\b/i,
  /\b(do not|don't|without) (delegate|delegating|use (an? )?(agent|specialist|subagent))\b/i,
]

const EXPLICIT_SINGLE_SPECIALIST_PATTERNS: RegExp[] = [
  /\bdelegate (this|it|the task)?\b/i,
  /\buse (an? )?(specialist|subagent)\b/i,
]

const EXPLICIT_MULTI_SPECIALIST_PATTERNS: RegExp[] = [
  /\b(use|delegate to|spawn) (multiple|several|two|three) (agents|specialists|subagents)\b/i,
  /\bmultiple[- ]agent\b/i,
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

const MCP_COMPOSITION_EXTERNAL_PATTERNS: RegExp[] = [
  /github/i,
  /issue/i,
  /pull request/i,
  /\bpr\b/i,
  /mcp/i,
  /context7/i,
  /remote api/i,
]

const MCP_COMPOSITION_ACTION_PATTERNS: RegExp[] = [
  /aggregate/i,
  /combine/i,
  /compare/i,
  /correlate/i,
  /summarize across/i,
  /fetch.*multiple/i,
  /list.*multiple/i,
  /search.*across/i,
  /multiple/i,
  /several/i,
  /all/i,
]

// ─── Classification logic ────────────────────────────────────────────────────

function matchesAny(input: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(input))
}

function detectSpecialistDomains(input: string): SpecialistDomain[] {
  const domains: SpecialistDomain[] = []
  if (matchesAny(input, SECURITY_PATTERNS)) domains.push("SECURITY")
  if (matchesAny(input, DEBUG_PATTERNS) || /\b(race|deadlock|intermittent)\b/i.test(input)) domains.push("DEBUG")
  if (matchesAny(input, UI_PATTERNS) || /\b(ui|frontend|client)\b/i.test(input)) domains.push("UI")
  if (matchesAny(input, BACKEND_PATTERNS) || /\b(api|database|db|server)\b/i.test(input)) domains.push("BACKEND")
  if (matchesAny(input, DEVOPS_PATTERNS)) domains.push("DEVOPS")
  if (matchesAny(input, RELEASE_PATTERNS)) domains.push("RELEASE")
  if (matchesAny(input, REVIEW_PATTERNS)) domains.push("REVIEW")
  if (matchesAny(input, ARCHITECTURE_PATTERNS)) domains.push("ARCHITECTURE")
  return domains
}

function classifySpecialistDomain(input: string): SpecialistDomain | null {
  return detectSpecialistDomains(input)[0] ?? null
}

function explicitlyRequestedMode(input: string): ExecutionMode | null {
  if (matchesAny(input, EXPLICIT_DIRECT_PATTERNS)) return "DIRECT"
  if (matchesAny(input, EXPLICIT_MULTI_SPECIALIST_PATTERNS)) return "MULTI_SPECIALIST"
  if (matchesAny(input, EXPLICIT_SINGLE_SPECIALIST_PATTERNS)) return "SINGLE_SPECIALIST"
  return null
}

const SPECIALIST_AGENT_MAP: Record<SpecialistDomain, string> = {
  SECURITY: "security-auditor",
  DEBUG: "debug-specialist",
  UI: "frontend-coder",
  BACKEND: "backend-coder",
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

  // ── FAST_DIRECT: trivial local task ──────────────────────────────────────
  const mcpCompositionCandidateRaw = matchesAny(text, MCP_COMPOSITION_EXTERNAL_PATTERNS) && matchesAny(text, MCP_COMPOSITION_ACTION_PATTERNS)
  const codeModeEval = evaluateCodeModeEligibility(prompt, mcpCompositionCandidateRaw)
  const mcpCompositionCandidate = codeModeEval.isEligible
  const codeModeRejectedReason = codeModeEval.rejectionReason
  const codeModeTelemetry = codeModeEval.telemetry

  const explicitMode = explicitlyRequestedMode(text)
  if (explicitMode === "DIRECT") {
    return {
      executionClass: "FAST_DIRECT",
      executionMode: explicitMode,
      reason: "User explicitly requested direct execution; specialist delegation is not justified.",
      reasonCode: "USER_REQUESTED_DIRECT",
      confidence: 1,
      forcedByExplicitSignal: true,
      mcpCompositionCandidate,
      codeModeRejectedReason,
      codeModeTelemetry,
    }
  }
  if (explicitMode === "MULTI_SPECIALIST") {
    return {
      executionClass: "PARALLEL_SPECIALISTS",
      executionMode: explicitMode,
      reason: "User explicitly requested bounded multi-specialist execution; downstream planning must still validate scope and fan-out.",
      reasonCode: "USER_REQUESTED_MULTI_SPECIALIST",
      confidence: 1,
      forcedByExplicitSignal: true,
      mcpCompositionCandidate,
      codeModeRejectedReason,
      codeModeTelemetry,
    }
  }
  if (explicitMode === "SINGLE_SPECIALIST") {
    const domain = classifySpecialistDomain(text)
    return {
      executionClass: "SPECIALIST",
      executionMode: explicitMode,
      ...(domain ? { specialists: [domain], suggestedAgents: [SPECIALIST_AGENT_MAP[domain]] } : {}),
      reason: "User explicitly requested a specialist; downstream planning must select one justified supported capability.",
      reasonCode: "USER_REQUESTED_SPECIALIST",
      confidence: 1,
      forcedByExplicitSignal: true,
      mcpCompositionCandidate,
      codeModeRejectedReason,
      codeModeTelemetry,
    }
  }

  // DEEP must precede length-based fallbacks: a short repository migration is still multi-domain work.
  if (matchesAny(text, DEEP_PATTERNS)) {
    const deepDomains: SpecialistDomain[] = ["ARCHITECTURE", "REVIEW"]
    return {
      executionClass: "DEEP",
      executionMode: "MULTI_SPECIALIST",
      specialists: deepDomains,
      suggestedAgents: deepDomains.map(domain => SPECIALIST_AGENT_MAP[domain]),
      reason: "Task matched architecture-level migration or breaking change pattern requiring bounded design and independent review work.",
      reasonCode: "MULTI_DEEP_MIGRATION",
      confidence: 0.85,
      forcedByExplicitSignal: false,
      mcpCompositionCandidate,
      codeModeRejectedReason,
      codeModeTelemetry,
    }
  }

  const isSimpleDirectQuery = matchesAny(text, SIMPLE_DIRECT_QUERY_PATTERNS)
  if (isSimpleDirectQuery && !hints?.isResuming) {
    return {
      executionClass: "FAST_DIRECT",
      executionMode: "DIRECT",
      reason: "Read-only or explanatory task has a bounded local answer and does not need specialist orchestration.",
      reasonCode: "DIRECT_SCOPED_QUERY",
      confidence: 0.9,
      forcedByExplicitSignal: false,
      mcpCompositionCandidate,
      codeModeRejectedReason,
      codeModeTelemetry,
    }
  }

  const isFastDirect = matchesAny(text, FAST_DIRECT_PATTERNS)
  if (isFastDirect && !hints?.isResuming) {
    const estFiles = hints?.estimatedFileCount ?? 1
    if (estFiles <= 2) {
      return {
        executionClass: "FAST_DIRECT",
        executionMode: "DIRECT",
        reason: "Trivial local task matched fast-direct pattern with minimal file surface.",
        reasonCode: "FAST_DIRECT_PATTERN",
        confidence: 0.9,
        forcedByExplicitSignal: false,
      mcpCompositionCandidate,
      codeModeRejectedReason,
      codeModeTelemetry,
      }
    }
  }

  // ── PARALLEL_SPECIALISTS: disjoint independent domains ───────────────────
  // Detect frontend + backend (or api + ui) pairs explicitly. The backend
  // workstream maps to backend-coder (NOT reviewer). UI maps to frontend-coder.
  const detectedDomains = detectSpecialistDomains(text)
  const crossDomainScope = /\b(across|and|plus|with|together)\b/i.test(text)
  const isParallel = matchesAny(text, PARALLEL_SIGNALS)
  if (isParallel || (crossDomainScope && detectedDomains.length >= 2)) {
    const domains = detectedDomains
    if (domains.length >= 2) {
      return {
        executionClass: "PARALLEL_SPECIALISTS",
        executionMode: "MULTI_SPECIALIST",
        specialists: domains,
        suggestedAgents: domains.map(d => SPECIALIST_AGENT_MAP[d]),
        reason: "Task contains disjoint independent domain signals (frontend + backend) with separate ownership — parallel specialist execution.",
        reasonCode: "PARALLEL_UI_BACKEND",
        confidence: 0.82,
        forcedByExplicitSignal: hints?.hasExplicitDomainSignal ?? true,
      mcpCompositionCandidate,
      codeModeRejectedReason,
      codeModeTelemetry,
      }
    }
    // Parallel-signal text with only ONE detected domain → treat as specialist for that domain
    if (domains.length === 1) {
      return {
        executionClass: "SPECIALIST",
        executionMode: "SINGLE_SPECIALIST",
        specialists: domains,
        suggestedAgents: domains.map(d => SPECIALIST_AGENT_MAP[d]),
        reason: "Task mentions parallel execution but only one clear domain — route to the single matching specialist.",
        reasonCode: "PARALLEL_SIGNAL_SINGLE_DOMAIN",
        confidence: 0.75,
        forcedByExplicitSignal: hints?.hasExplicitDomainSignal ?? true,
      mcpCompositionCandidate,
      codeModeRejectedReason,
      codeModeTelemetry,
      }
    }
    // Parallel signal with no detected domain → treat as STANDARD multi-workstream
    return {
      executionClass: "STANDARD",
      executionMode: "DIRECT",
      reason: "Task signals parallel work but no disjoint specialist domains were detected — scoped planning with independent workstreams.",
      reasonCode: "PARALLEL_SIGNAL_NO_DOMAIN",
      confidence: 0.65,
      forcedByExplicitSignal: false,
      mcpCompositionCandidate,
      codeModeRejectedReason,
      codeModeTelemetry,
    }
  }

  // ── SPECIALIST: single-domain expert ─────────────────────────────────────
  const domain = classifySpecialistDomain(text)
  if (domain) {
    return {
      executionClass: "SPECIALIST",
      executionMode: "SINGLE_SPECIALIST",
      specialists: [domain],
      suggestedAgents: [SPECIALIST_AGENT_MAP[domain]],
      reason: "Task matched specialist domain '" + domain + "' — route to dedicated specialist on turn 1.",
      reasonCode: "SPECIALIST_" + domain,
      confidence: 0.88,
      forcedByExplicitSignal: hints?.hasExplicitDomainSignal ?? false,
      mcpCompositionCandidate,
      codeModeRejectedReason,
      codeModeTelemetry,
    }
  }

  // ── STANDARD: multi-file feature or refactor ──────────────────────────────
  const estFiles = hints?.estimatedFileCount ?? 0
  if (matchesAny(text, STANDARD_PATTERNS) || estFiles > 3) {
    return {
      executionClass: "STANDARD",
      executionMode: "DIRECT",
      reason: "Multi-file feature or refactor task — requires scoped planning and execution.",
      reasonCode: "STANDARD_MULTIFILE",
      confidence: 0.75,
      forcedByExplicitSignal: false,
      mcpCompositionCandidate,
      codeModeRejectedReason,
      codeModeTelemetry,
    }
  }

  // ── FAST_DIRECT: simple, short prompt with no strong signals ─────────────
  const wordCount = text.split(/\s+/).length
  if (wordCount <= 15 && estFiles <= 1) {
    return {
      executionClass: "FAST_DIRECT",
      executionMode: "DIRECT",
      reason: "Short prompt with no complex signals — default to FAST_DIRECT.",
      reasonCode: "FAST_DIRECT_SHORT",
      confidence: 0.65,
      forcedByExplicitSignal: false,
      mcpCompositionCandidate,
      codeModeRejectedReason,
      codeModeTelemetry,
    }
  }

  // ── Default: STANDARD ─────────────────────────────────────────────────────
  return {
    executionClass: "STANDARD",
    executionMode: "DIRECT",
    reason: "No strong classification signal — falling back to STANDARD execution.",
    reasonCode: "STANDARD_FALLBACK",
    confidence: 0.6,
    forcedByExplicitSignal: false,
      mcpCompositionCandidate,
      codeModeRejectedReason,
      codeModeTelemetry,
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

/** Stable hash for deduplication / session-turn identity. Non-cryptographic. */
export function stableHash(input: string): string {
  let h1 = 0xDEADBEEF ^ 0
  let h2 = 0x41C6CE57 ^ 0
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  const r = (h1 ^ Math.imul(h2, 5)) >>> 0
  return "h" + (r % 0x7fffffff).toString(36)
}