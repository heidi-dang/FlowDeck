import { getAllAgentIds, getCanonicalAgent, getPrimaryAgentIds } from "../../services/canonical-registry"
import { validateWorkstreams } from "./planning"
import { CLASSIFIER_VERSION, ROUTING_POLICY_VERSION, TASK_CLASSES, taskAssessmentSchema, type BudgetProfile, type DelegationRecommendation, type ExecutionStrategy, type ParallelismLevel, type RoutingDecision, type RoutingEvidence, type TaskAssessment, type TaskClass, type Workstream, assertUniqueEvidence, fingerprint, routingDecisionSchema } from "./contracts/task-intelligence"

export interface TaskIntelligenceInput { runId: string; task: string; paths?: string[]; constraints?: string[]; repositorySignals?: string[]; sourceSha: string; contractId?: string; }
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9_./ -]+/g, " ").split(/\s+/).filter(Boolean)
const has = (all: string[], ...signals: string[]) => signals.some(s => all.includes(s) || all.some(x => x.includes(s)))
function ev(id: string, kind: string, signal: string, value: string, weight: number): RoutingEvidence { return { id, kind, signal, value, weight } }
function normalized(input: TaskIntelligenceInput): string[] { return [...words(input.task), ...(input.paths ?? []).flatMap(words), ...(input.constraints ?? []).flatMap(words), ...(input.repositorySignals ?? []).flatMap(words)].sort() }

export function classifyTask(input: TaskIntelligenceInput): TaskClass {
  const w = normalized(input)
  if (has(w, "security", "auth", "authorization", "secret", "cryptography", "payment")) return "security"
  if (has(w, "migration", "migrate", "schema", "database")) return "migration"
  if (has(w, "release", "publish", "npm", "version", "tag")) return "release"
  if (has(w, "ci", "github", "workflow", "pipeline", "deploy", "infrastructure")) return "ci_infrastructure"
  if (has(w, "performance", "latency", "slow", "benchmark", "throughput")) return "performance"
  if (has(w, "documentation", "docs", "readme", "changelog")) return "documentation"
  if (has(w, "test", "testing", "coverage", "regression")) return "testing"
  if (has(w, "audit", "review", "compliance")) return has(w, "review") ? "code_review" : "audit"
  if (has(w, "dependency", "upgrade", "package")) return "dependency"
  if (has(w, "architecture", "design", "system")) return "architecture"
  if (has(w, "investigate", "research", "find", "why")) return "investigation"
  if (has(w, "refactor", "restructure", "cleanup")) return "refactor"
  if (has(w, "bug", "fix", "broken", "regression")) return has(w, "large", "cross", "multiple") ? "large_bug" : "small_bug"
  if (has(w, "feature", "add", "build", "implement", "create")) return input.paths && input.paths.length > 3 ? "multi_component" : "feature"
  return "unknown"
}
function score(input: TaskIntelligenceInput, taskClass: TaskClass): Pick<TaskAssessment, "complexity" | "ambiguity" | "risk" | "evidence"> {
  const w = normalized(input), paths = [...new Set(input.paths ?? [])].sort(), evidence: RoutingEvidence[] = []
  const complexitySignals = [Math.min(40, paths.length * 8), has(w, "api", "ui", "database", "schema") ? 20 : 0, has(w, "concurrency", "parallel", "distributed") ? 20 : 0, has(w, "integration", "external", "provider") ? 15 : 0]
  const ambiguitySignals = [input.task.trim().length < 30 ? 35 : 0, input.constraints?.length ? 0 : 20, taskClass === "unknown" ? 45 : 0, has(w, "unclear", "maybe", "tbd", "figure") ? 30 : 0]
  const riskSignals = [has(w, "security", "auth", "authorization", "secret", "cryptography", "payment") ? 75 : 0, has(w, "migration", "schema", "database", "delete", "production", "deploy", "release") ? 65 : 0, has(w, "concurrency", "transaction", "locking") ? 55 : 0]
  const weighted = (vals: number[], name: string) => { const raw = Math.min(100, vals.reduce((a, b) => a + b, 0)); const e = ev(`${name}-${fingerprint({ w, paths }).slice(0, 12)}`, "score", name, String(raw), raw); evidence.push(e); return { score: raw, evidence: [e] } }
  const complexity = weighted(complexitySignals, "complexity"), ambiguity = weighted(ambiguitySignals, "ambiguity"), riskRaw = weighted(riskSignals, "risk")
  const risk = { score: Math.max(riskRaw.score, taskClass === "security" ? 75 : 0), evidence: riskRaw.evidence }
  assertUniqueEvidence(evidence)
  return { complexity, ambiguity, risk, evidence: [ev(`class-${fingerprint({ w }).slice(0, 12)}`, "classification", "taskClass", taskClass, 100), ...evidence] }
}
export function assessTask(input: TaskIntelligenceInput): TaskAssessment {
  const taskClass = classifyTask(input), s = score(input, taskClass)
  const parallelism: ParallelismLevel = (input.paths?.length ?? 0) > 3 ? "high" : (input.paths?.length ?? 0) > 1 ? "limited" : "none"
  const assessment = { assessmentId: `asm_${fingerprint({ ...input, taskClass }).slice(0, 24)}`, runId: input.runId, taskClass, ...s, parallelism, classifierVersion: CLASSIFIER_VERSION, policyVersion: ROUTING_POLICY_VERSION, createdAt: new Date(0).toISOString() }
  return taskAssessmentSchema.parse(assessment)
}
function workstreams(input: TaskIntelligenceInput): Workstream[] { return [...new Set(input.paths ?? [])].sort().map((path, i) => ({ id: `ws-${i + 1}`, ownership: [path], dependsOn: [], rationale: "Distinct normalized ownership path" })) }
function chooseStrategy(a: TaskAssessment): { strategy: ExecutionStrategy; rationale: string[]; rejected: string[] } {
  if (a.taskClass === "security" || a.risk.score >= 75) return { strategy: "security_review", rationale: ["security-sensitive signal or mandatory risk floor"], rejected: ["direct"] }
  if (a.taskClass === "investigation" || a.ambiguity.score >= 50) return { strategy: "investigate_then_direct", rationale: ["ambiguity requires repository evidence before mutation"], rejected: ["direct"] }
  if (a.parallelism === "high" && a.complexity.score >= 40) return { strategy: "parallel_implementation", rationale: ["independent ownership paths and sufficient complexity"], rejected: ["direct"] }
  if (a.taskClass === "large_bug") return { strategy: "debug_root_cause", rationale: ["large bug requires root-cause isolation"], rejected: ["direct"] }
  if (a.taskClass === "audit" || a.taskClass === "code_review") return { strategy: "audit_only", rationale: ["task requests inspection without mutation"], rejected: ["direct"] }
  if (a.complexity.score >= 40) return { strategy: "plan_then_execute", rationale: ["cross-surface complexity requires explicit plan"], rejected: ["direct"] }
  return { strategy: "direct", rationale: ["small, bounded task with no elevated risk or ambiguity"], rejected: ["parallel_implementation", "plan_then_execute"] }
}
function specialists(a: TaskAssessment, strategy: ExecutionStrategy, input: TaskIntelligenceInput): DelegationRecommendation[] {
  const requested = a.taskClass === "security" ? ["security-auditor", "reviewer"] : strategy === "parallel_implementation" ? ["backend-coder", "frontend-coder", "tester"] : a.taskClass === "investigation" ? ["researcher", "mapper"] : []
  return requested.filter(id => getAllAgentIds().includes(id) && !getPrimaryAgentIds().includes(id)).map(agentId => ({ agentId, capability: getCanonicalAgent(agentId)?.allowedTaskTypes[0] ?? "specialist", ownership: input.paths?.length ? [input.paths[0]] : ["task"], rationale: "Canonical registry capability match" }))
}
export function routeTask(input: TaskIntelligenceInput): RoutingDecision {
  const assessment = assessTask(input), selected = chooseStrategy(assessment), ws = workstreams(input), delegations = specialists(assessment, selected.strategy, input)
  validateWorkstreams(ws)
  const budgetRecommendation: BudgetProfile = assessment.risk.score >= 75 ? "deep-audit" : assessment.complexity.score >= 40 ? "audit" : assessment.complexity.score >= 20 ? "normal" : "small"
  const decision = { routingDecisionId: `route_${fingerprint({ input, assessment, selected, ws, delegations }).slice(0, 24)}`, runId: input.runId, sourceSha: input.sourceSha, assessment, strategy: selected.strategy, delegate: delegations.length > 0, delegations, workstreams: ws, budgetRecommendation, modelRecommendation: "advisory-only: preserve configured model", rationale: selected.rationale, rejectedAlternatives: selected.rejected, policyVersion: ROUTING_POLICY_VERSION, createdAt: new Date(0).toISOString(), finalized: true as const }
  return routingDecisionSchema.parse(decision)
}

export function assertCanonicalTaskClass(value: string): asserts value is TaskClass { if (!(TASK_CLASSES as readonly string[]).includes(value)) throw new Error(`ROUTING_UNKNOWN_TASK_CLASS:${value}`) }
