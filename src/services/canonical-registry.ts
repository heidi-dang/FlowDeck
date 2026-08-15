/**
 * Canonical Agent Registry
 *
 * SINGLE source of truth for every agent in the FlowDeck system.
 * All agent configuration, routing options, documentation counts,
 * and Doctor checks are derived from this registry.
 *
 * Do NOT maintain conflicting lists in separate files.
 * Every field here has a runtime consumer.
 */

export interface CanonicalAgentEntry {
  /** Unique identifier (matches AGENT_NAMES entry) */
  id: string
  /** Primary alias (if different from id) */
  alias?: string
  /** Human-readable description of the agent's role */
  description: string
  /** Agent mode: primary (UI-selectable) or subagent (internal delegation only) */
  mode: "primary" | "subagent"
  /** Types of tasks this agent can handle */
  allowedTaskTypes: string[]
  /** Tools this agent is permitted to use */
  allowedTools: string[]
  /** Actions this agent must never perform */
  forbiddenActions: string[]
  /** Files/directories this agent owns exclusively */
  ownedPaths: string[]
  /** Model policy: "inherit" (from UI) or specific model id */
  modelPolicy: string
  /** Delegation policy: "none", "justified_only", "all" */
  delegationPolicy: "none" | "justified_only"
  /** Maximum delegation depth (0 = none, 1 = exactly one level) */
  maxDelegationDepth: number
  /** Required inputs before the agent can execute */
  requiredInputs: string[]
  /** Expected output fields */
  expectedOutput: string[]
  /** Progress state labels */
  progressStates: string[]
  /** Conditions that trigger escalation to human */
  escalationConditions: string[]
  /** Conditions that cause agent to stop */
  stopConditions: string[]
  /** Criteria for successful completion */
  successCriteria: string[]
}

const CANONICAL_AGENTS: CanonicalAgentEntry[] = [
  {
    id: "heidi",
    description: "Heidi primary execution coordinator. Direct execution by default, delegating to specialists only when justified. Can edit code, run tests, and manage configuration directly.",
    mode: "primary",
    allowedTaskTypes: ["coordination", "orchestration", "direct-execution", "delegation", "phase-management", "implementation", "editing", "testing", "configuration"],
    allowedTools: [
      "read", "read_file", "write", "write_file", "edit", "edit_file", "patch", "patch_file", "apply_patch", "create_file", "hash-edit", "str-replace", "str_replace", "bash",
      "glob", "grep", "search",
      "planning-state", "codebase-state", "repo-memory",
      "codegraph", "load-rules", "list-rules",
      "task", "capture-lesson", "review-lessons",
      "fdx-read", "fdx-search", "fdx-grep", "fdx-outline", "fdx-batch",
      "fdx-impact", "fdx-diff", "fdx-git", "fdx-ls", "fdx-tree",
      "fdx-test", "fdx-lint",
    ],
    forbiddenActions: [
      "restart_opencode", "reboot_system", "logout_user",
      "spawn_nested_subagent", "rm_-rf_/",
    ],
    ownedPaths: ["~/.fd-plan/"],
    modelPolicy: "inherit",
    delegationPolicy: "justified_only",
    maxDelegationDepth: 1,
    requiredInputs: ["user prompt or STATE.md"],
    expectedOutput: ["execution_strategy", "completed_steps", "summary", "verification_result"],
    progressStates: ["intake", "route", "context", "execute", "verify", "complete"],
    escalationConditions: [
      "specialist agent fails twice",
      "circuit breaker triggered on 3rd failure",
      "ambiguous user requirements",
      "budget exceeded",
    ],
    stopConditions: [
      "all task steps completed and verified",
      "circuit breaker triggered",
      "user requests stop",
      "budget exhausted with no fallback",
    ],
    successCriteria: [
      "task executed directly or via justified delegation",
      "all verifications pass",
      "summary provided to user",
    ],
  },
  {
    id: "orchestrator",
    alias: "heidi",
    description: "Compatibility alias for Heidi primary coordinator. Same direct-execution capability as Heidi.",
    mode: "primary",
    allowedTaskTypes: ["coordination", "orchestration", "direct-execution", "delegation", "phase-management"],
    allowedTools: [
      "read", "read_file", "write", "write_file", "edit", "edit_file", "patch", "patch_file", "apply_patch", "create_file", "hash-edit", "str-replace", "str_replace", "bash",
      "glob", "grep", "search",
      "planning-state", "codebase-state", "repo-memory",
      "codegraph", "load-rules", "list-rules",
      "task", "capture-lesson", "review-lessons",
      "fdx-read", "fdx-search", "fdx-grep", "fdx-outline", "fdx-batch",
      "fdx-impact", "fdx-diff", "fdx-git", "fdx-ls", "fdx-tree",
      "fdx-test", "fdx-lint",
    ],
    forbiddenActions: [
      "restart_opencode", "reboot_system", "logout_user",
      "spawn_nested_subagent",
    ],
    ownedPaths: [],
    modelPolicy: "inherit",
    delegationPolicy: "justified_only",
    maxDelegationDepth: 1,
    requiredInputs: ["user prompt or STATE.md"],
    expectedOutput: ["execution_strategy", "completed_steps", "summary"],
    progressStates: ["intake", "route", "context", "execute", "verify", "complete"],
    escalationConditions: [
      "specialist agent fails twice",
      "circuit breaker triggered",
      "ambiguous requirements",
    ],
    stopConditions: [
      "all task steps completed and verified",
      "user requests stop",
    ],
    successCriteria: [
      "task executed directly or via justified delegation",
      "verifications pass",
      "summary provided",
    ],
  },
  {
    id: "planner",
    description: "Create detailed implementation plans with numbered steps, parallelization, and sizing.",
    mode: "subagent",
    allowedTaskTypes: ["planning", "task-breakdown", "step-decomposition"],
    allowedTools: ["read", "glob", "grep", "planning-state"],
    forbiddenActions: ["write source files", "run bash commands", "edit application code", "implement features"],
    ownedPaths: [],
    modelPolicy: "inherit",
    delegationPolicy: "none",
    maxDelegationDepth: 0,
    requiredInputs: ["task description or STATE.md"],
    expectedOutput: ["steps", "phase", "plan_md"],
    progressStates: ["analyze", "decompose", "write_plan", "review_plan"],
    escalationConditions: ["requirements ambiguous", "dependencies unclear", "conflicting constraints"],
    stopConditions: ["plan written and self-reviewed", "user confirms plan"],
    successCriteria: ["numbered steps with assigned agents", "each step has clear success criteria", "no implementation"],
  },
  {
    id: "architect",
    description: "Design system architecture, create ADRs, define API contracts and interface boundaries.",
    mode: "subagent",
    allowedTaskTypes: ["architecture", "adr", "api-design", "system-design"],
    allowedTools: ["read", "write", "glob", "grep", "planning-state", "capture-lesson", "review-lessons"],
    forbiddenActions: ["write application code", "run bash commands"],
    ownedPaths: [],
    modelPolicy: "inherit",
    delegationPolicy: "none",
    maxDelegationDepth: 0,
    requiredInputs: ["feature or system description", "existing codebase context"],
    expectedOutput: ["architecture_document", "adr", "api_contracts"],
    progressStates: ["analyze", "design", "document", "review"],
    escalationConditions: ["architectural conflict with existing system", "breaking API change required"],
    stopConditions: ["ADR written", "architecture reviewed"],
    successCriteria: ["architecture documented with tradeoffs", "no application code written"],
  },
  {
    id: "researcher",
    description: "Research documentation, APIs, best practices, and third-party libraries. Read-only analysis.",
    mode: "subagent",
    allowedTaskTypes: ["research", "api-lookup", "documentation", "best-practices"],
    allowedTools: ["read", "glob", "grep"],
    forbiddenActions: ["write or edit files", "implement solutions"],
    ownedPaths: [],
    modelPolicy: "inherit",
    delegationPolicy: "none",
    maxDelegationDepth: 0,
    requiredInputs: ["research topic or question"],
    expectedOutput: ["findings", "references", "recommendations"],
    progressStates: ["query", "analyze", "synthesize"],
    escalationConditions: ["critical information unavailable", "conflicting documentation"],
    stopConditions: ["research question answered", "findings documented"],
    successCriteria: ["findings clearly summarized", "sources cited", "no file modifications"],
  },
  {
    id: "mapper",
    description: "Explore and map codebase architecture, entry points, dependencies, and file structures.",
    mode: "subagent",
    allowedTaskTypes: ["mapping", "codebase-exploration", "structure-analysis", "dependency-graph"],
    allowedTools: ["read", "glob", "grep", "search", "codebase-state", "repo-memory", "codegraph", "fdx-read", "fdx-search", "fdx-grep", "fdx-outline", "fdx-ls", "fdx-tree"],
    forbiddenActions: ["write file", "edit file", "create file", "bash"],
    ownedPaths: [],
    modelPolicy: "inherit",
    delegationPolicy: "none",
    maxDelegationDepth: 0,
    requiredInputs: ["project root directory or mapping prompt"],
    expectedOutput: ["architecture_map", "entry_points", "dependencies"],
    progressStates: ["explore", "map", "document"],
    escalationConditions: ["codebase directory inaccessible", "unparseable structures"],
    stopConditions: ["architecture.md generated", "exploration finished"],
    successCriteria: ["codebase structural relationships mapped", "architecture document written", "no source modifications"],
  },
  {
    id: "backend-coder",
    description: "Implement backend features: API endpoints, services, data layer, business logic.",
    mode: "subagent",
    allowedTaskTypes: ["implementation", "backend", "api", "database", "service", "bugfix"],
    allowedTools: ["read", "write", "edit", "bash", "glob", "grep", "capture-lesson", "review-lessons"],
    forbiddenActions: ["modify frontend UI components", "change CI/CD without devops"],
    ownedPaths: [],
    modelPolicy: "inherit",
    delegationPolicy: "none",
    maxDelegationDepth: 0,
    requiredInputs: ["PLAN.md step description", "relevant context files"],
    expectedOutput: ["files_modified", "summary"],
    progressStates: ["implement", "test", "verify"],
    escalationConditions: ["architecture decision needed", "security-sensitive change without audit"],
    stopConditions: ["implementation complete", "tests pass"],
    successCriteria: ["code written per plan", "no regressions", "tests pass"],
  },
  {
    id: "frontend-coder",
    description: "Implement frontend features: UI components, client state, styling, rendering.",
    mode: "subagent",
    allowedTaskTypes: ["implementation", "frontend", "ui", "component", "styling", "bugfix"],
    allowedTools: ["read", "write", "edit", "bash", "glob", "grep", "capture-lesson", "review-lessons"],
    forbiddenActions: ["modify backend API files", "change server configuration"],
    ownedPaths: [],
    modelPolicy: "inherit",
    delegationPolicy: "none",
    maxDelegationDepth: 0,
    requiredInputs: ["PLAN.md step description", "design handoff for UI-heavy tasks"],
    expectedOutput: ["files_modified", "summary"],
    progressStates: ["implement", "test", "verify"],
    escalationConditions: ["design missing for UI-heavy task", "component library unclear"],
    stopConditions: ["implementation complete", "tests pass"],
    successCriteria: ["components implemented per spec", "no regressions", "tests pass"],
  },
  {
    id: "devops",
    description: "Implement DevOps and infrastructure changes: CI/CD, deployment, infra scripts.",
    mode: "subagent",
    allowedTaskTypes: ["implementation", "ci-cd", "deployment", "infrastructure", "operations"],
    allowedTools: ["read", "write", "edit", "bash", "glob", "grep", "capture-lesson", "review-lessons"],
    forbiddenActions: ["modify application source code", "deploy without approval"],
    ownedPaths: [],
    modelPolicy: "inherit",
    delegationPolicy: "none",
    maxDelegationDepth: 0,
    requiredInputs: ["PLAN.md step description"],
    expectedOutput: ["files_modified", "summary"],
    progressStates: ["implement", "verify", "review"],
    escalationConditions: ["production deployment requires approval", "destructive infra change"],
    stopConditions: ["infra change complete", "reviewer approves"],
    successCriteria: ["infrastructure code written per plan", "no prod deployment without approval"],
  },
  {
    id: "tester",
    description: "Write and run tests following TDD principles. Tests before implementation.",
    mode: "subagent",
    allowedTaskTypes: ["testing", "tdd", "regression", "integration-test", "unit-test"],
    allowedTools: ["read", "write", "edit", "bash", "glob", "grep", "capture-lesson", "review-lessons"],
    forbiddenActions: ["delete failing tests to make suite pass", "implement application features", "skip TDD cycle"],
    ownedPaths: [],
    modelPolicy: "inherit",
    delegationPolicy: "none",
    maxDelegationDepth: 0,
    requiredInputs: ["feature or step description", "relevant source files"],
    expectedOutput: ["test_files_written", "tests_passing", "coverage_summary"],
    progressStates: ["write_tests", "run_tests", "verify"],
    escalationConditions: ["test infrastructure broken", "flaky tests blocking progress"],
    stopConditions: ["all tests pass", "coverage meets threshold"],
    successCriteria: ["tests written before implementation", "all new tests pass"],
  },
  {
    id: "reviewer",
    description: "Review code quality, security, and convention adherence. Read-only.",
    mode: "subagent",
    allowedTaskTypes: ["review", "code-review", "quality-check"],
    allowedTools: ["read", "glob", "grep"],
    forbiddenActions: ["write or edit any files", "make code changes"],
    ownedPaths: [],
    modelPolicy: "inherit",
    delegationPolicy: "none",
    maxDelegationDepth: 0,
    requiredInputs: ["files to review", "context of changes"],
    expectedOutput: ["verdict", "issues", "recommendations"],
    progressStates: ["inspect", "analyze", "report"],
    escalationConditions: ["security issues found", "critical bugs found", "architectural violations"],
    stopConditions: ["review complete", "verdict issued"],
    successCriteria: ["structured review with severity levels", "no file modifications"],
  },
  {
    id: "security-auditor",
    description: "Security audit: OWASP Top 10, injection, auth vulnerabilities. Read-only.",
    mode: "subagent",
    allowedTaskTypes: ["security-audit", "vulnerability-scan", "auth-review"],
    allowedTools: ["read", "glob", "grep"],
    forbiddenActions: ["write or edit files", "make changes to fix vulnerabilities"],
    ownedPaths: [],
    modelPolicy: "inherit",
    delegationPolicy: "none",
    maxDelegationDepth: 0,
    requiredInputs: ["files to audit", "change context"],
    expectedOutput: ["findings", "severity_breakdown", "recommendations"],
    progressStates: ["audit", "analyze", "report"],
    escalationConditions: ["CRITICAL vulnerability found", "auth bypass detected", "data exposure found"],
    stopConditions: ["audit complete", "all findings documented"],
    successCriteria: ["OWASP checklist evaluated", "findings documented with severity", "no file modifications"],
  },
  {
    id: "debug-specialist",
    description: "Diagnose bugs through systematic root cause analysis. Fix build, type, and dependency failures.",
    mode: "subagent",
    allowedTaskTypes: ["debug", "bug-investigation", "root-cause-analysis", "build-fix", "type-fix"],
    allowedTools: ["read", "write", "edit", "bash", "glob", "grep", "capture-lesson", "review-lessons"],
    forbiddenActions: ["fix behavioral bugs (diagnose only)", "change unrelated files", "weaken types"],
    ownedPaths: [],
    modelPolicy: "inherit",
    delegationPolicy: "none",
    maxDelegationDepth: 0,
    requiredInputs: ["bug report or build error output", "stack trace, reproduction steps, or affected files"],
    expectedOutput: ["root_cause", "explanation", "recommended_fix"],
    progressStates: ["reproduce", "analyze", "diagnose", "fix"],
    escalationConditions: ["reproduction steps missing", "root cause outside listed files"],
    stopConditions: ["root cause identified", "build green (tsc + build exit 0)"],
    successCriteria: ["root cause traced to specific call site", "fixes applied with minimum changes", "no new type suppressions"],
  },
  {
    id: "browser-debugger",
    description: "Autonomous browser debugging specialist for reproducing, diagnosing, and repairing UI/console/network errors in web applications.",
    mode: "subagent",
    allowedTaskTypes: ["browser-debug", "console-fix", "ui-repair", "frontend-debug", "network-debug", "react-debug"],
    allowedTools: ["read", "write", "edit", "bash", "glob", "grep", "apply_patch"],
    forbiddenActions: ["destructive-form-submit", "delete-account", "make-payments"],
    ownedPaths: [],
    modelPolicy: "inherit",
    delegationPolicy: "none",
    maxDelegationDepth: 0,
    requiredInputs: ["url or dev server output", "symptom description or console bug report"],
    expectedOutput: ["browser_evidence", "root_cause", "applied_patch", "verification_report"],
    progressStates: ["inspect", "launch", "explore", "diagnose", "repair", "verify"],
    escalationConditions: ["browser process crash", "unrepairable framework error"],
    stopConditions: ["no actionable browser failures remaining", "max repair cycles reached"],
    successCriteria: ["zero actionable console errors", "zero uncaught exceptions", "fresh browser verification passed"],
  },
]

// ─── Registry exports ─────────────────────────────────────────────────────

const REGISTRY = new Map<string, CanonicalAgentEntry>(CANONICAL_AGENTS.map(a => [a.id, a]))

/** Get a canonical agent entry by name. Returns null for unknown agents. */
export function getCanonicalAgent(id: string): CanonicalAgentEntry | null {
  return REGISTRY.get(id) ?? null
}

/** Get all canonical agent entries. */
export function getAllCanonicalAgents(): CanonicalAgentEntry[] {
  return [...CANONICAL_AGENTS]
}

/** Get all agent IDs (primary + subagent). */
export function getAllAgentIds(): string[] {
  return CANONICAL_AGENTS.map(a => a.id)
}

/** Get only primary (UI-selectable) agent IDs. */
export function getPrimaryAgentIds(): string[] {
  return CANONICAL_AGENTS.filter(a => a.mode === "primary").map(a => a.id)
}

/** Get only subagent (internal-only) IDs. */
export function getSubagentIds(): string[] {
  return CANONICAL_AGENTS.filter(a => a.mode === "subagent").map(a => a.id)
}

/** Get the count of registered agents. */
export function getAgentCount(): number {
  return CANONICAL_AGENTS.length
}

/** Get all tools used across all agents (for doc generation). */
export function getAllUsedTools(): Set<string> {
  const tools = new Set<string>()
  for (const agent of CANONICAL_AGENTS) {
    for (const tool of agent.allowedTools) {
      tools.add(tool)
    }
  }
  return tools
}

/** Check if a tool is used by any agent. */
export function isToolUsedByAnyAgent(toolName: string): boolean {
  for (const agent of CANONICAL_AGENTS) {
    if (agent.allowedTools.includes(toolName)) return true
  }
  return false
}

/** Check if an agent can delegate (only heidi/orchestrator can). */
export function canAgentDelegate(agentId: string): boolean {
  const agent = REGISTRY.get(agentId)
  return agent?.delegationPolicy === "justified_only"
}

/** Check if an agent is a specialist (subagent with no delegation). */
export function isSpecialistAgent(agentId: string): boolean {
  const agent = REGISTRY.get(agentId)
  return agent?.delegationPolicy === "none"
}

/** Validate delegation depth. */
export function validateDelegation(
  delegatingAgent: string,
  currentDepth: number,
): { allowed: boolean; reason?: string } {
  if (!canAgentDelegate(delegatingAgent)) {
    return { allowed: false, reason: `Agent "${delegatingAgent}" cannot delegate. Only Heidi may delegate.` }
  }
  if (currentDepth >= 1) {
    return { allowed: false, reason: `Maximum delegation depth of 1 exceeded.` }
  }
  return { allowed: true }
}
