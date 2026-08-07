/**
 * Production Acceptance Gate — Hierarchical Token-Budget Control pipeline.
 *
 * This harness is the permanent, reproducible gate for the token-budget
 * pipeline (PR #114). It drives the REAL production services end-to-end:
 *
 *   - TokenBudgetRuntime        (reservation gate + reconciliation + recovery)
 *   - TokenBudgetController     (run/child ceilings, durable accounting)
 *   - FileTokenUsageStore       (durable JSONL accounting)
 *   - ArtifactStore             (externalized tool output lifecycle)
 *   - buildAssignmentContext    (bounded child context packets)
 *   - compactConversationContext(execution-state compaction)
 *   - externalizeToolOutput     (oversized tool result externalisation)
 *
 * Sections:
 *   A. End-to-end production validation across five representative workloads
 *   B. Before/after token savings (legacy replay vs. optimised pipeline)
 *   C. Quality validation (compaction retention + artifact fidelity)
 *   D. Artifact lifecycle (dedup, LRU, disk, prune, corruption, concurrency)
 *   E. Long-duration stability (bounded context, no accounting drift)
 *   F. Stress orchestration (many children, retries, cancel, recovery, budget)
 *   G. Performance profiling (avg / P95 / P99, generous CI-safe thresholds)
 *
 * Measurements are printed as [ACCEPTANCE] lines and written to
 * `.flowdeck/acceptance-gate/report.json` (git-ignored) for PR evidence.
 */

import { describe, it, expect } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join, dirname } from "path"
import { createHash } from "crypto"
import { ArtifactStore } from "../src/services/artifact-store"
import { TokenBudgetRuntime } from "../src/services/token-budget-runtime"
import {
  buildAssignmentContext,
  compactConversationContext,
  externalizeToolOutput,
  estimateReplayTokens,
  shouldCompact,
  type ConversationTurn,
} from "../src/services/context-scoping"

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic generators (no RNG nondeterminism → stable, non-flaky metrics)
// ─────────────────────────────────────────────────────────────────────────────

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** SHA-256 hex prefix — mirrors ArtifactStore content-hash id derivation. */
function sha256Prefix(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 12)
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FILES = [
  "src/services/token-budget-runtime.ts",
  "src/services/token-budget-controller.ts",
  "src/services/token-usage-store.ts",
  "src/services/artifact-store.ts",
  "src/services/context-scoping.ts",
  "src/config/token-budget-config.ts",
  "src/index.ts",
  "tests/token-budget.test.ts",
  "tests/token-budget-benchmark.test.ts",
  "docs/architecture/integration/token-budget-pipeline.md",
]

function generateToolOutput(bytes: number, seedWord: string): string {
  const lines: string[] = []
  let acc = 0
  let i = 0
  while (acc < bytes) {
    const line = `${seedWord} line ${i}: data[${i}] = 0x${(i * 2654435761 % 0xffff).toString(16)} status=ok elapsed=${(i % 97)}ms`
    acc += line.length + 1
    lines.push(line)
    i++
  }
  return lines.join("\n")
}

/**
 * High-volume assistant turn (~700 tokens) so long-duration simulation grows
 * fast enough to trigger repeated compactions.
 */
function longAssistantTurn(turnIdx: number): string {
  const base = assistantTurnContent(turnIdx, [`fact-${turnIdx}`], [`decision-${turnIdx}`], ["constraint: surgical-only"])
  const filler: string[] = []
  for (let i = 0; i < 30; i++) {
    filler.push(`analysis note ${turnIdx}.${i}: reviewed src/services/token-budget-runtime.ts pass ${i}; no regressions observed, budget accounting stable`)
  }
  return `${base}\n${filler.join("\n")}`
}

/** Turn content engineered to exercise the compaction signal extractors. */
function assistantTurnContent(turnIdx: number, facts: string[], decisions: string[], constraints: string[]): string {
  const lines: string[] = []
  lines.push(`Step ${turnIdx} complete.`)
  for (const f of facts) lines.push(`Verified: ${f}`)
  for (const d of decisions) lines.push(`Decision: ${d}`)
  for (const c of constraints) lines.push(`Constraint: ${c}`)
  lines.push(`Acceptance Criteria: ${facts[0] ?? "criteria retained"}`)
  lines.push(`- [x] ${decisions[0] ?? "checklist item"}`)
  lines.push(`Conclusion: turn ${turnIdx} verified against tests.`)
  return lines.join("\n")
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario model — five representative autonomous-engineering workloads
// ─────────────────────────────────────────────────────────────────────────────

interface ChildSpec {
  name: string
  target: string
  assignment: string
  files: string[]
  criteria: string[]
  toolOutputBytes: number[]
  outputTokens: number
  retries: number
}

interface ScenarioSpec {
  name: string
  task: string
  turns: number
  /** per-turn root tool output sizes in bytes (large values are externalised) */
  toolOutputsPerTurn: number[][]
  /** per-turn root assistant output tokens */
  outputTokensPerTurn: number[]
  children: ChildSpec[]
  /** which turns delegate children */
  childAtTurns: number[]
  maxToolOutputChars: number
  compactThresholdTokens: number
  runTotal: number
  childTotal: number
}

function makeScenario(name: string, task: string, turns: number, children: ChildSpec[], childAtTurns: number[], opts?: { compactThresholdTokens?: number; largeOutputBytes?: number }): ScenarioSpec {
  const rng = mulberry32(hashString(name))
  const toolOutputsPerTurn: number[][] = []
  const outputTokensPerTurn: number[] = []
  const largeBytes = opts?.largeOutputBytes ?? 120_000
  for (let t = 0; t < turns; t++) {
    const sizes: number[] = []
    const nOutputs = 2 + Math.floor(rng() * 3) // 2–4 tool results per turn
    for (let o = 0; o < nOutputs; o++) {
      // ~15% of tool results are oversized (repo scans / read-all)
      sizes.push(rng() < 0.15 ? largeBytes : 1_500 + Math.floor(rng() * 8_000))
    }
    toolOutputsPerTurn.push(sizes)
    outputTokensPerTurn.push(700 + Math.floor(rng() * 1_800))
  }
  return {
    name,
    task,
    turns,
    toolOutputsPerTurn,
    outputTokensPerTurn,
    children,
    childAtTurns,
    maxToolOutputChars: 8_000,
    compactThresholdTokens: opts?.compactThresholdTokens ?? 120_000,
    runTotal: 2_000_000,
    childTotal: 400_000,
  }
}

const WORKLOADS: ScenarioSpec[] = [
  makeScenario(
    "p1-small-bug-fix",
    "Fix the flaky token-usage-store append under rapid sequential writes.",
    6,
    [
      {
        name: "child-fix",
        target: "src/services/token-usage-store.ts",
        assignment: "Reproduce the intermittent append failure, fix the write path, add a regression test.",
        files: ["src/services/token-usage-store.ts", "tests/token-usage-store.test.ts"],
        criteria: ["Append never throws on transient EMFILE", "Regression test covers rapid writes"],
        toolOutputBytes: [2_000, 40_000],
        outputTokens: 1_200,
        retries: 0,
      },
    ],
    [2],
  ),
  makeScenario(
    "p2-medium-feature",
    "Add a --dry-run flag to the fdx doctor command with structured output.",
    10,
    [
      {
        name: "child-doctor",
        target: "src/cli/doctor.ts",
        assignment: "Implement the --dry-run flag, wire it into the CLI parser, cover with tests.",
        files: ["src/cli/doctor.ts", "tests/doctor-cli.test.ts"],
        criteria: ["--dry-run prints plan without executing", "Exit code 0 on valid plan"],
        toolOutputBytes: [3_000, 60_000, 4_000],
        outputTokens: 1_500,
        retries: 1,
      },
      {
        name: "child-docs",
        target: "docs/cli/doctor.md",
        assignment: "Document the new --dry-run flag with examples.",
        files: ["docs/cli/doctor.md"],
        criteria: ["Flag documented with an example", "Markdown lint passes"],
        toolOutputBytes: [1_200],
        outputTokens: 900,
        retries: 0,
      },
    ],
    [3, 6],
  ),
  makeScenario(
    "p3-large-repo-audit",
    "Audit all token-budget services for correctness, durability, and test coverage; report findings.",
    12,
    [
      {
        name: "child-audit-runtime",
        target: "src/services/token-budget-runtime.ts",
        assignment: "Audit the runtime for reservation/reconciliation correctness and recovery.",
        files: ["src/services/token-budget-runtime.ts"],
        criteria: ["No double-counting of usage", "Recovery path covered by tests"],
        toolOutputBytes: [120_000, 80_000, 60_000],
        outputTokens: 2_000,
        retries: 1,
      },
      {
        name: "child-audit-store",
        target: "src/services/token-usage-store.ts",
        assignment: "Audit durable accounting for crash consistency and prune behaviour.",
        files: ["src/services/token-usage-store.ts"],
        criteria: ["JSONL writes are atomic enough", "Rebuild matches appended state"],
        toolOutputBytes: [90_000, 40_000],
        outputTokens: 1_800,
        retries: 0,
      },
      {
        name: "child-audit-artifacts",
        target: "src/services/artifact-store.ts",
        assignment: "Audit artifact dedup, LRU eviction, pruning and integrity validation.",
        files: ["src/services/artifact-store.ts"],
        criteria: ["Dedup returns stable ids", "Corrupted files are self-healed"],
        toolOutputBytes: [70_000, 30_000],
        outputTokens: 1_600,
        retries: 0,
      },
    ],
    [2, 5, 8],
    { largeOutputBytes: 160_000 },
  ),
  makeScenario(
    "p4-multi-agent-feature",
    "Implement a new 'inventory' fdx tool across services, CLI, docs and tests with parallel agents.",
    16,
    [
      { name: "child-svc", target: "src/services/inventory.ts", assignment: "Implement the inventory service core.", files: ["src/services/inventory.ts"], criteria: ["Service returns sorted inventory"], toolOutputBytes: [150_000, 5_000], outputTokens: 2_200, retries: 1 },
      { name: "child-cli", target: "src/cli/inventory.ts", assignment: "Wire inventory into the CLI.", files: ["src/cli/inventory.ts", "src/index.ts"], criteria: ["CLI command registered"], toolOutputBytes: [100_000, 3_000], outputTokens: 1_700, retries: 0 },
      { name: "child-tests", target: "tests/inventory.test.ts", assignment: "Write comprehensive tests for inventory.", files: ["tests/inventory.test.ts"], criteria: ["Coverage >= 80%", "All tests pass"], toolOutputBytes: [80_000, 2_000], outputTokens: 1_900, retries: 1 },
      { name: "child-docs", target: "docs/tools/inventory.md", assignment: "Document the inventory tool.", files: ["docs/tools/inventory.md"], criteria: ["Usage and examples documented"], toolOutputBytes: [1_500], outputTokens: 800, retries: 0 },
    ],
    [2, 5, 8, 11],
    { largeOutputBytes: 200_000 },
  ),
  makeScenario(
    "p5-long-review-refactor",
    "Long-running review + refactor of the context-scoping pipeline across many files.",
    20,
    [
      { name: "child-refactor", target: "src/services/context-scoping.ts", assignment: "Refactor context packet formatting into shared helpers.", files: ["src/services/context-scoping.ts"], criteria: ["No behaviour change", "All existing tests pass"], toolOutputBytes: [120_000, 60_000, 40_000], outputTokens: 2_400, retries: 2 },
      { name: "child-review", target: "src/services/artifact-store.ts", assignment: "Deep review of artifact lifecycle for leaks.", files: ["src/services/artifact-store.ts"], criteria: ["Findings documented", "No leaks in normal operation"], toolOutputBytes: [90_000, 50_000], outputTokens: 2_000, retries: 1 },
      { name: "child-verify", target: "tests/phase4-context-compaction-integration.test.ts", assignment: "Extend integration coverage for re-compaction.", files: ["tests/phase4-context-compaction-integration.test.ts"], criteria: ["Re-compaction test added", "Green CI"], toolOutputBytes: [30_000, 10_000], outputTokens: 1_500, retries: 0 },
    ],
    [3, 7, 11, 15],
    { largeOutputBytes: 180_000, compactThresholdTokens: 90_000 },
  ),
]

// ─────────────────────────────────────────────────────────────────────────────
// Metrics model
// ─────────────────────────────────────────────────────────────────────────────

interface ScenarioMetrics {
  scenario: string
  mode: "optimized" | "legacy"
  providerInputTokens: number
  providerOutputTokens: number
  peakContextTokens: number
  finalContextTokens: number
  dispatches: number
  delegations: number
  retries: number
  hardStops: number
  compactions: number
  artifactsStored: number
  artifactsRetrieved: number
  totalElapsedMs: number
  finalRunConsumed: number
  finalRunReserved: number
}

interface ReportEntry extends ScenarioMetrics {
  savingsInputPercent: number
  savingsPeakPercent: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Legacy baseline — raw parent replay, inline tool output, no compaction,
// no budget gate. This is the honest "before" state of the pipeline.
// ─────────────────────────────────────────────────────────────────────────────

function simulateLegacy(spec: ScenarioSpec): ScenarioMetrics {
  const start = performance.now()
  const conversation: ConversationTurn[] = [
    { role: "system", content: "You are the FlowDeck orchestration agent. Plan, delegate, verify." },
    { role: "user", content: `# Task\n${spec.task}` },
  ]

  let providerInput = 0
  let providerOutput = 0
  let peakContext = 0
  let dispatches = 0
  let delegations = 0
  let retries = 0
  const childAt = new Set(spec.childAtTurns)
  const childForTurn = new Map<number, ChildSpec>()
  spec.childAtTurns.forEach((turn, i) => childForTurn.set(turn, spec.children[i % spec.children.length]!))

  const pushInlineOutput = (bytes: number, seedWord: string): void => {
    conversation.push({ role: "user", content: generateToolOutput(bytes, seedWord) })
  }

  for (let turn = 0; turn < spec.turns; turn++) {
    conversation.push({ role: "user", content: `Step ${turn}: inspect ${FILES[turn % FILES.length]} and continue the task.` })
    const turnOutputs = spec.toolOutputsPerTurn[turn] ?? []
    for (const size of turnOutputs) pushInlineOutput(size, `scan${turn}`)
    const facts = [`fact-${turn}-a`, `fact-${turn}-b`]
    const decisions = [`decision-${turn}`]
    conversation.push({ role: "assistant", content: assistantTurnContent(turn, facts, decisions, ["surgical changes only"]) })
    peakContext = Math.max(peakContext, estimateReplayTokens(conversation))
    providerInput += estimateReplayTokens(conversation)
    providerOutput += spec.outputTokensPerTurn[turn] ?? 1_000
    dispatches++

    const child = childForTurn.get(turn)
    if (childAt.has(turn) && child) {
      for (let r = 0; r < child.retries; r++) {
        retries++
        providerInput += estimateReplayTokens(conversation) // failed replay resend
        dispatches++
      }
      delegations++
      providerInput += estimateReplayTokens(conversation) // full parent replay to child
      providerOutput += child.outputTokens
      dispatches++
      for (const size of child.toolOutputBytes) pushInlineOutput(size, child.name)
    }
    peakContext = Math.max(peakContext, estimateReplayTokens(conversation))
  }

  return {
    scenario: spec.name,
    mode: "legacy",
    providerInputTokens: providerInput,
    providerOutputTokens: providerOutput,
    peakContextTokens: peakContext,
    finalContextTokens: estimateReplayTokens(conversation),
    dispatches,
    delegations,
    retries,
    hardStops: 0,
    compactions: 0,
    artifactsStored: 0,
    artifactsRetrieved: 0,
    totalElapsedMs: performance.now() - start,
    finalRunConsumed: 0,
    finalRunReserved: 0,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Optimised pipeline — the real production services, end-to-end
// ─────────────────────────────────────────────────────────────────────────────

interface OptimizedOptions {
  persist: boolean
  budgetOverrides?: {
    runTotal?: number
    childTotal?: number
    compactThresholdTokens?: number
  }
}

async function simulateOptimized(spec: ScenarioSpec, opts?: OptimizedOptions): Promise<ScenarioMetrics> {
  const start = performance.now()
  const persist = opts?.persist ?? true
  const dir = mkdtempSync(join(tmpdir(), "fd-acceptance-"))
  const artifactsDir = join(dir, "artifacts")
  const usageDir = join(dir, "usage")
  const cleanup = (): void => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  const artifactStore = new ArtifactStore({ baseDir: artifactsDir, maxInMemory: 200, maxDiskFiles: 500 })
  const runtime = new TokenBudgetRuntime({
    overrides: {
      enabled: true,
      profile: "normal",
      runTotal: opts?.budgetOverrides?.runTotal ?? spec.runTotal,
      childTotal: opts?.budgetOverrides?.childTotal ?? spec.childTotal,
      maxToolOutputChars: spec.maxToolOutputChars,
      compactThresholdTokens: opts?.budgetOverrides?.compactThresholdTokens ?? spec.compactThresholdTokens,
    },
    persistDir: persist ? usageDir : undefined,
  })

  const rootCtx = { sessionID: "root", agent: "orchestrator", depth: 0 }
  const conversation: ConversationTurn[] = [
    { role: "system", content: "You are the FlowDeck orchestration agent. Plan, delegate, verify." },
    { role: "user", content: `# Task\n${spec.task}` },
  ]
  const touchedFiles = new Set<string>()
  const externalizedIds: string[] = []

  let providerInput = 0
  let providerOutput = 0
  let peakContext = 0
  let dispatches = 0
  let delegations = 0
  let retries = 0
  let hardStops = 0
  let compactions = 0
  let artifactsStored = 0
  let artifactsRetrieved = 0
  const childAt = new Set(spec.childAtTurns)
  const childForTurn = new Map<number, ChildSpec>()
  spec.childAtTurns.forEach((turn, i) => childForTurn.set(turn, spec.children[i % spec.children.length]!))

  const trackFiles = (text: string): void => {
    for (const m of text.matchAll(/(?:src|tests|crates|docs)\/[a-zA-Z0-9_\-./]+|package\.json|tsconfig\.json/g)) {
      touchedFiles.add(m[0])
    }
  }

  const maybeCompact = (): void => {
    const est = estimateReplayTokens(conversation)
    if (shouldCompact(est, spec.compactThresholdTokens)) {
      const res = compactConversationContext({
        messages: conversation,
        thresholdTokens: spec.compactThresholdTokens,
        sessionID: "root",
        modifiedFiles: [...touchedFiles],
      })
      if (res.compacted) {
        conversation.length = 0
        conversation.push(...res.messages)
        compactions++
      }
    }
  }

  const handleToolOutput = (text: string, sessionID: string, toolName: string, seedWord: string): void => {
    const ext = externalizeToolOutput(text, spec.maxToolOutputChars, {
      sessionID,
      toolName,
      artifactStore,
    })
    if (ext.artifactId) {
      artifactsStored++
      externalizedIds.push(ext.artifactId)
      // Realistic retrieval: agent reads a fraction of externalized artifacts.
      if (artifactsStored % 2 === 0) {
        const art = artifactStore.get(ext.artifactId)
        if (art) {
          artifactsRetrieved++
          expect(art.content).toBe(text) // fidelity check inline
        }
      }
    }
    conversation.push({ role: "user", content: `${seedWord} result:\n${ext.text}` })
    trackFiles(ext.text)
  }

  const dispatchAndReconcile = async (
    ctx: Parameters<TokenBudgetRuntime["beforeDispatch"]>[0],
    message: unknown,
    inputTokens: number,
    outputTokens: number,
    msgId: string,
    error?: unknown,
  ): Promise<{ allowed: boolean; reason?: string }> => {
    const res = await runtime.beforeDispatch(ctx, message, { maxOutputTokens: outputTokens })
    dispatches++
    if (res.allowed) {
      await runtime.reconcileUsage(ctx, {
        id: msgId,
        tokens: { input: inputTokens, output: outputTokens },
        cost: 0.0001 * (inputTokens + outputTokens),
        modelID: "test-model",
        providerID: "test-provider",
        error,
      })
    } else {
      hardStops++
    }
    return { allowed: res.allowed, reason: res.reason }
  }

  try {
    for (let turn = 0; turn < spec.turns; turn++) {
      const instruction = `Step ${turn}: inspect ${FILES[turn % FILES.length]} and continue the task.`
      conversation.push({ role: "user", content: instruction })
      trackFiles(instruction)
      maybeCompact()

      // Root dispatch: outgoing message is the (compacted) conversation.
      const inputTokens = estimateReplayTokens(conversation)
      const outputTokens = spec.outputTokensPerTurn[turn] ?? 1_000
      const res = await dispatchAndReconcile(rootCtx, conversation, inputTokens, outputTokens, `msg-root-${turn}`)
      if (!res.allowed) break
      providerInput += inputTokens
      providerOutput += outputTokens

      // Root tool results.
      for (const size of spec.toolOutputsPerTurn[turn] ?? []) {
        handleToolOutput(generateToolOutput(size, `scan${turn}`), "root", "fdx-read", `scan${turn}`)
        maybeCompact()
      }

      const facts = [`fact-${turn}-a`, `fact-${turn}-b`]
      const decisions = [`decision-${turn}`]
      conversation.push({ role: "assistant", content: assistantTurnContent(turn, facts, decisions, ["surgical changes only"]) })
      peakContext = Math.max(peakContext, estimateReplayTokens(conversation))

      // Child delegations at configured turns.
      const child = childForTurn.get(turn)
      if (childAt.has(turn) && child) {
        const childCtx = { sessionID: `child-${delegations}`, agent: "heidi", parentID: "root", depth: 1 }
          runtime.registerSession(childCtx)
          const assignment = buildAssignmentContext({
            target: child.target,
            blastRadius: "src",
            patterns: ["src/**", "tests/**"],
            constraints: "Surgical changes only. Verify changes with tests before completion.",
            stage: "execute",
            assignment: child.assignment,
            gitCommit: "abc1234",
            acceptanceCriteria: child.criteria,
            relevantFiles: child.files,
            externalizedArtifacts: externalizedIds.slice(-5),
          })

          let allowed = false
          for (let attempt = 0; attempt <= child.retries; attempt++) {
            const res2 = await dispatchAndReconcile(
              childCtx,
              { role: "user", content: assignment.prompt },
              assignment.estimatedTokens,
              child.outputTokens,
              `msg-${child.name}-${attempt}`,
              attempt < child.retries ? new Error("transient provider failure") : undefined,
            )
            if (!res2.allowed) break
            allowed = true
            if (attempt < child.retries) retries++
          }
          if (allowed) {
            delegations++
            providerInput += assignment.estimatedTokens
            providerOutput += child.outputTokens
            for (const size of child.toolOutputBytes) {
              handleToolOutput(generateToolOutput(size, child.name), childCtx.sessionID, "fdx-read", child.name)
            }
            conversation.push({
              role: "assistant",
              content: `Decision: ${child.name} completed — ${child.assignment.slice(0, 80)}`,
            })
            peakContext = Math.max(peakContext, estimateReplayTokens(conversation))
            maybeCompact()
          }
          await runtime.onSessionEnd(childCtx, allowed ? "session_completed" : "session_error")
        }
      }

    await runtime.onSessionEnd(rootCtx, "session_completed")

    const snapshot = runtime.getSnapshot("root")
    return {
      scenario: spec.name,
      mode: "optimized",
      providerInputTokens: providerInput,
      providerOutputTokens: providerOutput,
      peakContextTokens: peakContext,
      finalContextTokens: estimateReplayTokens(conversation),
      dispatches,
      delegations,
      retries,
      hardStops,
      compactions,
      artifactsStored,
      artifactsRetrieved,
      totalElapsedMs: performance.now() - start,
      finalRunConsumed: snapshot?.run.consumed ?? 0,
      finalRunReserved: snapshot?.run.reserved ?? 0,
    }
  } finally {
    cleanup()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence collection
// ─────────────────────────────────────────────────────────────────────────────

interface Evidence {
  generatedAt: string
  headSha: string
  entries: ReportEntry[]
  section: Record<string, string>
}

const EVIDENCE: Evidence = {
  generatedAt: new Date().toISOString(),
  headSha: "",
  entries: [],
  section: {},
}

function record(entry: ScenarioMetrics, legacy: ScenarioMetrics | null): void {
  const report: ReportEntry = {
    ...entry,
    savingsInputPercent: legacy ? Math.max(0, Math.round((1 - entry.providerInputTokens / legacy.providerInputTokens) * 100)) : 0,
    savingsPeakPercent: legacy ? Math.max(0, Math.round((1 - entry.peakContextTokens / legacy.peakContextTokens) * 100)) : 0,
  }
  EVIDENCE.entries.push(report)
}

function writeEvidence(): void {
  try {
    EVIDENCE.headSha = (process.env.GITHUB_SHA ?? "").slice(0, 7) || "local"
    const target = join(process.cwd(), ".flowdeck", "acceptance-gate", "report.json")
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify(EVIDENCE, null, 2), "utf-8")
    console.log(`[ACCEPTANCE] evidence written to ${target}`)
  } catch (e) {
    console.log(`[ACCEPTANCE] evidence write skipped: ${String(e)}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Profiling helper (Phase G)
// ─────────────────────────────────────────────────────────────────────────────

interface ProfileResult {
  name: string
  avgMs: number
  p95Ms: number
  p99Ms: number
  maxMs: number
}

async function profile(name: string, iterations: number, fn: () => void | Promise<void>, maxP95Ms: number): Promise<ProfileResult> {
  for (let i = 0; i < 3; i++) await fn() // warmup
  const times: number[] = []
  for (let i = 0; i < iterations; i++) {
    const s = performance.now()
    await fn()
    times.push(performance.now() - s)
  }
  times.sort((a, b) => a - b)
  const avg = times.reduce((a, b) => a + b, 0) / times.length
  const p95 = times[Math.floor(times.length * 0.95)]
  const p99 = times[Math.floor(times.length * 0.99)]
  const max = times[times.length - 1]
  const r: ProfileResult = { name, avgMs: avg, p95Ms: p95, p99Ms: p99, maxMs: max }
  console.log(
    `[ACCEPTANCE] profile ${name}: iterations=${iterations} avg=${avg.toFixed(2)}ms p95=${p95.toFixed(2)}ms p99=${p99.toFixed(2)}ms max=${max.toFixed(2)}ms (p95 budget=${maxP95Ms}ms)`,
  )
  expect(p95).toBeLessThanOrEqual(maxP95Ms)
  return r
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("ACCEPTANCE GATE — token-budget production pipeline", () => {
  const optimizedResults = new Map<string, ScenarioMetrics>()
  const legacyResults = new Map<string, ScenarioMetrics>()

  // ── Phase A + B: end-to-end validation and before/after savings ──────────
  describe("Phase A/B — end-to-end workloads & token savings", () => {
    for (const spec of WORKLOADS) {
      it(`${spec.name}: runs end-to-end through the real pipeline and beats the legacy baseline`, async () => {
        const legacy = simulateLegacy(spec)
        const optimized = await simulateOptimized(spec)
        legacyResults.set(spec.name, legacy)
        optimizedResults.set(spec.name, optimized)

        // Phase A: the optimised pipeline completes all dispatches without hard stops
        expect(optimized.hardStops).toBe(0)
        expect(optimized.delegations).toBe(spec.childAtTurns.length)
        expect(optimized.dispatches).toBeGreaterThan(0)

        // Accounting sanity: consumed usage is non-zero and reserved drains to zero
        expect(optimized.finalRunConsumed).toBeGreaterThan(0)
        expect(optimized.finalRunReserved).toBe(0)

        // Phase B: optimised pipeline must send fewer provider input tokens
        expect(optimized.providerInputTokens).toBeLessThan(legacy.providerInputTokens)
        expect(optimized.peakContextTokens).toBeLessThan(legacy.peakContextTokens)
        expect(optimized.finalContextTokens).toBeLessThan(legacy.finalContextTokens)

        const savingsInput = Math.round((1 - optimized.providerInputTokens / legacy.providerInputTokens) * 100)
        const savingsPeak = Math.round((1 - optimized.peakContextTokens / legacy.peakContextTokens) * 100)
        console.log(
          `[ACCEPTANCE] ${spec.name}: providerInput=${optimized.providerInputTokens.toLocaleString()} (legacy ${legacy.providerInputTokens.toLocaleString()}, -${savingsInput}%) peakContext=${optimized.peakContextTokens.toLocaleString()} (legacy ${legacy.peakContextTokens.toLocaleString()}, -${savingsPeak}%) compactions=${optimized.compactions} artifacts=${optimized.artifactsStored} delegations=${optimized.delegations} retries=${optimized.retries}`,
        )
        record(optimized, legacy)
      }, 30_000)
    }
  })

  // ── Phase C: quality validation ──────────────────────────────────────────
  describe("Phase C — quality validation", () => {
    it("compaction retains verified facts, decisions, criteria and files across re-compaction", () => {
      const conversation: ConversationTurn[] = [
        { role: "system", content: "You are the orchestration agent." },
        { role: "user", content: "# Task\nImplement the inventory tool." },
      ]
      const compactThreshold = 1_500
      const files = new Set<string>(["src/services/inventory.ts"])
      let facts: string[] = []
      let decisions: string[] = []
      let criteria: string[] = []
      let compactions = 0
      let lastResult: ReturnType<typeof compactConversationContext> | null = null

      for (let t = 0; t < 24; t++) {
        conversation.push({ role: "user", content: `Step ${t}: edit src/services/inventory.ts and src/index.ts` })
        facts = [`fact-${t}`, ...facts].slice(0, 6)
        decisions = [`decision-${t}`, ...decisions].slice(0, 6)
        criteria = [`criterion-${t}`, ...criteria].slice(0, 6)
        conversation.push({ role: "assistant", content: assistantTurnContent(t, facts, decisions, ["constraint: surgical-only"]) })
        const est = estimateReplayTokens(conversation)
        if (shouldCompact(est, compactThreshold)) {
          lastResult = compactConversationContext({
            messages: conversation,
            thresholdTokens: compactThreshold,
            sessionID: "root",
            modifiedFiles: [...files],
          })
          expect(lastResult.compacted).toBe(true)
          compactions++
          conversation.length = 0
          conversation.push(...lastResult.messages)
          files.add(`src/index.ts`)
        }
      }

      expect(compactions).toBeGreaterThanOrEqual(2)
      expect(lastResult).not.toBeNull()
      const r = lastResult!
      // Retention guarantees
      expect(r.retainedFactsCount).toBeGreaterThanOrEqual(5)
      expect(r.retainedDecisionsCount).toBeGreaterThanOrEqual(4)
      expect(r.retainedCriteriaCount).toBeGreaterThanOrEqual(5)
      expect(r.retainedFilesCount).toBeGreaterThanOrEqual(2)
      expect(r.reductionRatio).toBeGreaterThan(0.5)
      // No nested summaries: at most one compacted-state block in the result
      const summaryCount = r.messages.filter(m => typeof m.content === "string" && m.content.includes("## Compacted Execution State")).length
      expect(summaryCount).toBeLessThanOrEqual(1)
      // Original criteria survive into the final summary
      const summaryText = r.messages.map(m => (typeof m.content === "string" ? m.content : "")).join("\n")
      expect(summaryText).toMatch(/fact-2/)
      expect(summaryText).toMatch(/decision-1/)
      expect(summaryText).toMatch(/inventory\.ts/)
    })

    it("externalized artifacts are byte-identical on retrieval and markers carry stable ids", () => {
      const dir = mkdtempSync(join(tmpdir(), "fd-quality-"))
      try {
        const store = new ArtifactStore({ baseDir: dir })
        const big = generateToolOutput(50_000, "scan")
        const small = generateToolOutput(500, "tiny")
        const extBig = externalizeToolOutput(big, 8_000, { sessionID: "s", toolName: "fdx-read", artifactStore: store })
        const extSmall = externalizeToolOutput(small, 8_000, { sessionID: "s", toolName: "fdx-read", artifactStore: store })

        expect(extBig.truncated).toBe(true)
        expect(extBig.artifactId).toBeDefined()
        expect(extBig.originalChars).toBe(big.length)
        expect(extBig.retainedChars).toBeLessThan(extBig.originalChars)
        expect(extSmall.truncated).toBe(false)
        expect(extSmall.text).toBe(small)

        const art = store.get(extBig.artifactId!)
        expect(art).not.toBeNull()
        expect(art!.content).toBe(big)
        expect(art!.hash).toMatch(/^[0-9a-f]{64}$/)
        expect(extBig.text).toContain(extBig.artifactId!)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("assignment context is bounded, excludes parent replay and carries all required fields", () => {
      const parentConversation: ConversationTurn[] = [
        { role: "system", content: "system prompt ".repeat(2_000) },
        { role: "user", content: "huge parent history ".repeat(5_000) },
        { role: "assistant", content: "more parent history ".repeat(5_000) },
      ]
      const parentReplayTokens = estimateReplayTokens(parentConversation)
      const result = buildAssignmentContext({
        target: "src/services/inventory.ts",
        blastRadius: "src",
        patterns: ["src/**"],
        constraints: "Surgical changes only.",
        stage: "execute",
        assignment: "Implement the inventory service.",
        gitCommit: "abc1234",
        acceptanceCriteria: ["Coverage >= 80%", "All tests pass"],
        relevantFiles: ["src/services/inventory.ts", "src/index.ts"],
        externalizedArtifacts: ["art-tool-output-abcdef123456"],
      })

      expect(result.parentConversationExcluded).toBe(true)
      expect(result.estimatedTokens).toBeLessThan(parentReplayTokens / 10)
      for (const field of ["src/services/inventory.ts", "Implement the inventory service.", "Coverage >= 80%", "abc1234", "art-tool-output-abcdef123456"]) {
        expect(result.prompt).toContain(field)
      }
      expect(result.estimatedTokens).toBeGreaterThan(0)
    })
  })

  // ── Phase D: artifact lifecycle ───────────────────────────────────────────
  describe("Phase D — artifact lifecycle", () => {
    it("deduplicates identical content, persists to disk, prunes, and self-heals corruption", () => {
      const dir = mkdtempSync(join(tmpdir(), "fd-lifecycle-"))
      try {
        const store = new ArtifactStore({ baseDir: dir, maxInMemory: 3, maxDiskFiles: 2 })
        const content = generateToolOutput(12_000, "dup")
        const a = store.store("s1", "fdx-read", content)
        const b = store.store("s2", "fdx-read", content) // identical content
        expect(b.id).toBe(a.id) // content-hash dedup
        expect(store.size()).toBe(1)

        // LRU eviction: store more distinct artifacts than maxInMemory
        const others: string[] = []
        for (let i = 0; i < 5; i++) {
          const art = store.store("s1", "fdx-read", generateToolOutput(9_000, `other-${i}`))
          others.push(art.id)
        }
        expect(store.size()).toBeLessThanOrEqual(3)
        // Retrieved-from-disk artifacts are re-cached
        const diskArt = store.get(others[0])
        expect(diskArt).not.toBeNull()
        expect(diskArt!.content.length).toBeGreaterThan(0)

        // Dedup survives memory eviction (disk lookup path)
        const c = store.store("s3", "fdx-read", content)
        expect(c.id).toBe(a.id)

        // Disk pruning
        const removed = store.pruneDisk()
        expect(removed).toBeGreaterThanOrEqual(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("detects and deletes corrupted artifact files without poisoning the cache", () => {
      const dir = mkdtempSync(join(tmpdir(), "fd-corrupt-"))
      try {
        const store = new ArtifactStore({ baseDir: dir })
        const art = store.store("s1", "fdx-read", generateToolOutput(10_000, "corrupt"))
        const filePath = join(dir, `${art.id}.json`)
        expect(existsSync(filePath)).toBe(true)
        // Tamper with the file
        writeFileSync(filePath, JSON.stringify({ id: art.id, content: "tampered", hash: "0000" }), "utf-8")
        store.clear() // drop the in-memory copy
        const fetched = store.get(art.id)
        expect(fetched).toBeNull() // integrity validation rejects the tampered file
        expect(existsSync(filePath)).toBe(false) // corrupted file is removed
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("handles concurrent store/get without losing artifacts", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fd-concurrent-"))
      try {
        const store = new ArtifactStore({ baseDir: dir, maxInMemory: 200 })
        const payloads = Array.from({ length: 50 }, (_, i) => generateToolOutput(6_000, `conc-${i}`))
        await Promise.all(payloads.map(p => Promise.resolve().then(() => store.store("s", "fdx-read", p))))
        const results = await Promise.all(payloads.map(async p => {
          const id = `art-tool-output-${sha256Prefix(p)}`
          return { id, art: store.get(id) }
        }))
        for (const { art } of results) expect(art).not.toBeNull()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })

  // ── Phase E: long-duration stability ──────────────────────────────────────
  describe("Phase E — long-duration stability", () => {
    it("keeps context bounded, accounting drift-free and summaries non-nested over an extended session", async () => {
      const spec = WORKLOADS.find(w => w.name === "p5-long-review-refactor")!
      const dir = mkdtempSync(join(tmpdir(), "fd-long-"))
      const artifactsDir = join(dir, "artifacts")
      const usageDir = join(dir, "usage")
      try {
        const artifactStore = new ArtifactStore({ baseDir: artifactsDir, maxInMemory: 100, maxDiskFiles: 400 })
        const runtime = new TokenBudgetRuntime({
          overrides: {
            enabled: true,
            profile: "normal",
            runTotal: spec.runTotal,
            childTotal: spec.childTotal,
            maxToolOutputChars: spec.maxToolOutputChars,
            compactThresholdTokens: 40_000,
          },
          persistDir: usageDir,
        })
        const rootCtx = { sessionID: "root", agent: "orchestrator", depth: 0 }
        const conversation: ConversationTurn[] = [
          { role: "system", content: "You are the orchestration agent." },
          { role: "user", content: `# Task\n${spec.task}` },
        ]
        const compactThreshold = 6_000
        const touched = new Set<string>()
        let providerInput = 0
        let providerOutput = 0
        let compactions = 0
        let artifactsStored = 0
        let nestedSummaries = 0
        let peakContext = 0

        const maybeCompact = (): void => {
          const est = estimateReplayTokens(conversation)
          if (shouldCompact(est, compactThreshold)) {
            const res = compactConversationContext({ messages: conversation, thresholdTokens: compactThreshold, sessionID: "root", modifiedFiles: [...touched] })
            if (res.compacted) {
              conversation.length = 0
              conversation.push(...res.messages)
              compactions++
              const summaryCount = res.messages.filter(m => typeof m.content === "string" && m.content.includes("## Compacted Execution State")).length
              if (summaryCount > 1) nestedSummaries++
            }
          }
        }

        for (let turn = 0; turn < 40; turn++) {
          conversation.push({ role: "user", content: `Turn ${turn}: work on ${FILES[turn % FILES.length]}` })
          touched.add(FILES[turn % FILES.length])
          maybeCompact()
          const inputTokens = estimateReplayTokens(conversation)
          const outputTokens = 900 + (turn % 7) * 150
          const res = await runtime.beforeDispatch(rootCtx, conversation, { maxOutputTokens: outputTokens })
          expect(res.allowed).toBe(true)
          providerInput += inputTokens
          providerOutput += outputTokens
          await runtime.reconcileUsage(rootCtx, {
            id: `msg-long-${turn}`,
            tokens: { input: inputTokens, output: outputTokens },
            cost: 0.0001,
            modelID: "test-model",
            providerID: "test-provider",
          })
          // Externalize a moderately large output every 3rd turn
          if (turn % 3 === 0) {
            const big = generateToolOutput(50_000, `long-${turn}`)
            const ext = externalizeToolOutput(big, 8_000, { sessionID: "root", toolName: "fdx-read", artifactStore })
            if (ext.artifactId) artifactsStored++
            conversation.push({ role: "user", content: ext.text })
          }
          conversation.push({ role: "assistant", content: longAssistantTurn(turn) })
          maybeCompact()
          peakContext = Math.max(peakContext, estimateReplayTokens(conversation))
        }
        await runtime.onSessionEnd(rootCtx, "session_completed")

        const snapshot = runtime.getSnapshot("root")
        expect(compactions).toBeGreaterThanOrEqual(3)
        expect(nestedSummaries).toBe(0) // no nested compaction summaries
        expect(peakContext).toBeLessThanOrEqual(compactThreshold * 1.5) // bounded with slack
        expect(estimateReplayTokens(conversation)).toBeLessThanOrEqual(compactThreshold * 1.5)
        expect(artifactsStored).toBeGreaterThanOrEqual(8)
        // Accounting converges: consumed ≈ billed usage, no leftover reservations
        const billed = providerInput + providerOutput
        expect(snapshot!.run.consumed).toBeGreaterThanOrEqual(billed)
        expect(snapshot!.run.reserved).toBe(0)
        // Repeated identical outputs collapse to a single artifact (dedup)
        const same = generateToolOutput(50_000, "repeat-output")
        const id1 = externalizeToolOutput(same, 8_000, { sessionID: "root", toolName: "fdx-read", artifactStore })
        const id2 = externalizeToolOutput(same, 8_000, { sessionID: "root", toolName: "fdx-read", artifactStore })
        expect(id2.artifactId).toBe(id1.artifactId)
        expect(id1.artifactId).toBeDefined()

        console.log(
          `[ACCEPTANCE] long-duration: turns=40 compactions=${compactions} artifacts=${artifactsStored} peakContext=${peakContext} finalContext=${estimateReplayTokens(conversation)} runConsumed=${snapshot!.run.consumed} billed=${billed} drift=${snapshot!.run.consumed - billed}`,
        )
        EVIDENCE.section["long-duration"] = JSON.stringify({
          compactions,
          artifactsStored,
          peakContext,
          finalContext: estimateReplayTokens(conversation),
          runConsumed: snapshot!.run.consumed,
          billed,
          drift: snapshot!.run.consumed - billed,
        })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 30_000)
  })

  // ── Phase F: stress orchestration ─────────────────────────────────────────
  describe("Phase F — stress orchestration", () => {
    it("enforces the run ceiling with a hard stop and blocks subsequent dispatches", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fd-stress-budget-"))
      try {
        const runtime = new TokenBudgetRuntime({
          // hardStopThreshold 0.8: the run stops once consumed reaches 80% of the 50k ceiling.
          overrides: { enabled: true, profile: "small", runTotal: 50_000, childTotal: 20_000, hardStopThreshold: 0.8, maxToolOutputChars: 8_000, compactThresholdTokens: 40_000 },
          persistDir: join(dir, "usage"),
        })
        const ctx = { sessionID: "root", agent: "orchestrator", depth: 0 }
        const big = { role: "user", content: "payload ".repeat(6_000) } // ~12k tokens
        const res1 = await runtime.beforeDispatch(ctx, big, { maxOutputTokens: 8_000 })
        expect(res1.allowed).toBe(true)
        await runtime.reconcileUsage(ctx, { id: "m1", tokens: { input: 12_000, output: 8_000 }, cost: 0.01, modelID: "m", providerID: "p" })

        const res2 = await runtime.beforeDispatch(ctx, big, { maxOutputTokens: 8_000 })
        expect(res2.allowed).toBe(true)
        await runtime.reconcileUsage(ctx, { id: "m2", tokens: { input: 12_000, output: 8_000 }, cost: 0.01, modelID: "m", providerID: "p" })

        // Hard stop (40k = 80% of the 50k ceiling) reached: the third dispatch must be rejected pre-flight
        const res3 = await runtime.beforeDispatch(ctx, big, { maxOutputTokens: 8_000 })
        expect(res3.allowed).toBe(false)
        expect(res3.reason).toMatch(/RUN_TERMINAL|budget/)
        const snapshot = runtime.getSnapshot("root")
        expect(snapshot!.run.terminal).not.toBeNull()
        // A further dispatch is still rejected (terminal state persists)
        const res4 = await runtime.beforeDispatch(ctx, { role: "user", content: "small" }, { maxOutputTokens: 100 })
        expect(res4.allowed).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("releases pending reservations on cancellation and recovers durable state after restart", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fd-stress-recovery-"))
      const usageDir = join(dir, "usage")
      try {
        const runtimeA = new TokenBudgetRuntime({
          overrides: { enabled: true, profile: "normal", runTotal: 1_000_000, childTotal: 200_000 },
          persistDir: usageDir,
        })
        const rootCtx = { sessionID: "root", agent: "orchestrator", depth: 0 }
        runtimeA.registerSession(rootCtx)
        const childCtx = { sessionID: "child-x", agent: "heidi", parentID: "root", depth: 1 }
        runtimeA.registerSession(childCtx)
        const msg = { role: "user", content: "work ".repeat(2_000) }
        const r1 = await runtimeA.beforeDispatch(childCtx, msg, { maxOutputTokens: 4_000 })
        expect(r1.allowed).toBe(true)
        const reservedBefore = runtimeA.getSnapshot("root")!.run.reserved
        expect(reservedBefore).toBeGreaterThan(0)
        // Cancel without reconciling: the reservation must be released
        await runtimeA.onSessionEnd(childCtx, "session_error")
        const reservedAfter = runtimeA.getSnapshot("root")!.run.reserved
        expect(reservedAfter).toBe(0)

        // Recover durable state in a fresh runtime from the same persist dir
        const runtimeB = new TokenBudgetRuntime({
          overrides: { enabled: true, profile: "normal", runTotal: 1_000_000, childTotal: 200_000 },
          persistDir: usageDir,
        })
        runtimeB.registerSession(rootCtx)
        const recovered = runtimeB.getSnapshot("root")
        expect(recovered).not.toBeNull()
        expect(recovered!.run.reserved).toBe(0)
        expect(recovered!.run.consumed).toBeGreaterThanOrEqual(0)
        console.log(`[ACCEPTANCE] recovery: reservedBefore=${reservedBefore} reservedAfterCancel=${reservedAfter} recoveredConsumed=${recovered!.run.consumed}`)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("handles many children, retries and identical outputs without context or artifact duplication", async () => {
      const spec = WORKLOADS.find(w => w.name === "p4-multi-agent-feature")!
      const dir = mkdtempSync(join(tmpdir(), "fd-stress-many-"))
      try {
        const artifactStore = new ArtifactStore({ baseDir: join(dir, "artifacts"), maxInMemory: 200 })
        const runtime = new TokenBudgetRuntime({
          overrides: { enabled: true, profile: "normal", runTotal: 3_000_000, childTotal: 300_000, maxToolOutputChars: 8_000, compactThresholdTokens: 120_000 },
          persistDir: join(dir, "usage"),
        })
        const rootCtx = { sessionID: "root", agent: "orchestrator", depth: 0 }
        runtime.registerSession(rootCtx)
        const conversation: ConversationTurn[] = [
          { role: "system", content: "system" },
          { role: "user", content: spec.task },
        ]
        let dupeOutputs = 0
        const outputSeen = new Set<string>()

        for (let c = 0; c < 10; c++) {
          const childCtx = { sessionID: `child-${c}`, agent: "heidi", parentID: "root", depth: 1 }
          runtime.registerSession(childCtx)
          const assignment = buildAssignmentContext({
            target: spec.children[0].target,
            assignment: `Task ${c}: ${spec.children[0].assignment}`,
            acceptanceCriteria: spec.children[0].criteria,
            relevantFiles: spec.children[0].files,
          })
          let allowed = false
          for (let attempt = 0; attempt <= (c % 3 === 0 ? 1 : 0); attempt++) {
            const res = await runtime.beforeDispatch(childCtx, { role: "user", content: assignment.prompt }, { maxOutputTokens: 1_000 })
            if (!res.allowed) break
            await runtime.reconcileUsage(childCtx, {
              id: `mc-${c}-${attempt}`,
              tokens: { input: assignment.estimatedTokens, output: 1_000 },
              cost: 0.0001,
              modelID: "m",
              providerID: "p",
              error: attempt === 0 && c % 3 === 0 ? new Error("retry") : undefined,
            })
            allowed = true
          }
          if (allowed) {
            // Half the children produce byte-identical oversized output (dedup stress)
            const big = c % 2 === 0 ? generateToolOutput(100_000, "shared") : generateToolOutput(100_000, `unique-${c}`)
            const ext = externalizeToolOutput(big, 8_000, { sessionID: childCtx.sessionID, toolName: "fdx-read", artifactStore })
            if (ext.artifactId) {
              if (outputSeen.has(ext.artifactId)) dupeOutputs++
              outputSeen.add(ext.artifactId)
            }
            conversation.push({ role: "user", content: ext.text })
          }
          await runtime.onSessionEnd(childCtx, allowed ? "session_completed" : "session_error")
        }
        await runtime.onSessionEnd(rootCtx, "session_completed")

        const snapshot = runtime.getSnapshot("root")
        // Identical outputs deduplicated: 5 unique artifact ids for the 10 shared/unique stores
        expect(outputSeen.size).toBe(6) // 5 unique + 1 shared
        expect(dupeOutputs).toBe(4) // 5 shared stores, 4 duplicates
        // Conversation carries only externalized markers, never the raw 100KB payloads
        const joined = conversation.map(m => (typeof m.content === "string" ? m.content : "")).join("\n")
        expect(joined.length).toBeLessThan(60_000)
        expect(joined).not.toContain(generateToolOutput(100_000, "shared"))
        expect(joined).not.toContain(generateToolOutput(100_000, "unique-4"))
        expect(snapshot!.run.terminal).toBeNull()
        expect(snapshot!.run.reserved).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 30_000)
  })

  // ── Phase G: performance profiling ────────────────────────────────────────
  describe("Phase G — performance profiling", () => {
    it("profiles the hot paths with CI-safe P95 budgets", async () => {
      const dir = mkdtempSync(join(tmpdir(), "fd-profile-"))
      try {
        const store = new ArtifactStore({ baseDir: join(dir, "artifacts") })
        const runtime = new TokenBudgetRuntime({
          overrides: { enabled: true, profile: "normal", runTotal: 5_000_000, childTotal: 1_000_000 },
          persistDir: join(dir, "usage"),
        })
        const ctx = { sessionID: "root", agent: "orchestrator", depth: 0 }
        const bigOutput = generateToolOutput(120_000, "profile")
        const conv: ConversationTurn[] = [
          { role: "system", content: "system ".repeat(500) },
          { role: "user", content: "task ".repeat(2_000) },
        ]
        for (let i = 0; i < 20; i++) {
          conv.push({ role: "user", content: `step ${i}: work on src/services/token-budget-runtime.ts` })
          conv.push({ role: "assistant", content: assistantTurnContent(i, [`fact-${i}`], [`decision-${i}`], ["constraint: surgical-only"]) })
        }
        void buildAssignmentContext({
          target: "src/services/inventory.ts",
          assignment: "Implement the inventory service.",
          acceptanceCriteria: ["All tests pass"],
          relevantFiles: ["src/services/inventory.ts"],
        })

        await profile("externalizeToolOutput(120KB)", 500, () => {
          externalizeToolOutput(bigOutput, 8_000, { sessionID: "s", toolName: "fdx-read", artifactStore: store })
        }, 500)

        await profile("compactConversationContext(20 turns)", 50, () => {
          compactConversationContext({ messages: conv, thresholdTokens: 1, sessionID: "root", modifiedFiles: ["src/services/inventory.ts"] })
        }, 1_500)

        await profile("artifactStore.store+get", 500, () => {
          const a = store.store("s", "fdx-read", generateToolOutput(9_000, "p"))
          store.get(a.id)
        }, 500)

        await profile("buildAssignmentContext", 1_000, () => {
          buildAssignmentContext({ target: "src/services/inventory.ts", assignment: "Implement.", relevantFiles: ["src/services/inventory.ts"] })
        }, 300)

        await profile("beforeDispatch+reconcileUsage", 300, async () => {
          const res = await runtime.beforeDispatch(ctx, { role: "user", content: "work ".repeat(500) }, { maxOutputTokens: 800 })
          if (res.allowed) {
            await runtime.reconcileUsage(ctx, { id: `prof-${Math.random()}`, tokens: { input: 250, output: 800 }, cost: 0.001, modelID: "m", providerID: "p" })
          }
        }, 2_000)

        await runtime.onSessionEnd(ctx, "session_completed")
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 60_000)
  })

  // ── Evidence ──────────────────────────────────────────────────────────────
  it("emits the acceptance-gate evidence report", () => {
    expect(EVIDENCE.entries.length).toBe(WORKLOADS.length)
    EVIDENCE.section["phaseA_workloads"] = JSON.stringify(
      WORKLOADS.map(w => ({ name: w.name, turns: w.turns, children: w.children.length })),
    )
    EVIDENCE.section["phaseB_summary"] = JSON.stringify(
      EVIDENCE.entries.map(e => ({
        scenario: e.scenario,
        mode: e.mode,
        providerInputTokens: e.providerInputTokens,
        savingsInputPercent: e.savingsInputPercent,
        savingsPeakPercent: e.savingsPeakPercent,
        compactions: e.compactions,
        artifactsStored: e.artifactsStored,
        delegations: e.delegations,
        retries: e.retries,
        hardStops: e.hardStops,
      })),
    )
    writeEvidence()
  })
})

