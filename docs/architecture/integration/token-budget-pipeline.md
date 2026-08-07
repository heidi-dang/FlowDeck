# Token-Budget / Context-Scoping Pipeline — Architecture

**Status:** Published
**Branch:** `fix/token-budget-control`
**HEAD:** `ecde6d7` (parent: `761f5b8`)
**Scope:** `src/services/token-budget-controller.ts`, `src/services/token-budget-runtime.ts`,
`src/services/token-usage-store.ts`, `src/services/context-scoping.ts`,
`src/services/artifact-store.ts`, `src/config/token-budget-config.ts`, wiring in `src/index.ts`

---

## Table of Contents

1. [Overview — One Authoritative Pipeline](#1-overview--one-authoritative-pipeline)
2. [Budget Hierarchy: run → agent/session → assignment → request](#2-budget-hierarchy-run--agentsession--assignment--request)
3. [Pre-Dispatch Gate](#3-pre-dispatch-gate)
4. [Reconciliation (commitUsage)](#4-reconciliation-commitusage)
5. [Persistence & Recovery](#5-persistence--recovery)
6. [Context Scoping (buildAssignmentContext)](#6-context-scoping-buildassignmentcontext)
7. [Context Compaction (compactConversationContext)](#7-context-compaction-compactconversationcontext)
8. [Tool-Output Externalisation](#8-tool-output-externalisation)
9. [Telemetry](#9-telemetry)
10. [Configuration Reference](#10-configuration-reference)
11. [Provider Integration Guidance](#11-provider-integration-guidance)
12. [Known Limitations & Failure Modes](#12-known-limitations--failure-modes)

---

## 1. Overview — One Authoritative Pipeline

FlowDeck enforces token spend through **one authoritative, runtime-owned pipeline**.
There is exactly one budget model per run; every model invocation is attributable to
exactly one run and is gated, reconciled, and persisted through that single model.
No other code path "checks" or "adjusts" the budget — everything funnels through
`TokenBudgetController` (`src/services/token-budget-controller.ts`, header comment).

The pipeline has four cooperating stages:

1. **Budget gate BEFORE dispatch.** Every model request must first win a
   reservation from the run budget. The reservation is taken **atomically** under an
   in-process mutex before the request is sent — there is no check-then-act race, so
   concurrent agents cannot oversubscribe the same remaining run budget
   (`reserveRequest`, `token-budget-controller.ts:340–404`).
2. **Reconcile AFTER.** When the assistant message lands with real provider usage,
   the reservation is reconciled: unused reserved output is released, actual usage is
   charged, and a single warning / hard-stop decision is made
   (`commitUsage`, `token-budget-controller.ts:413–503`).
3. **Context scoping + compaction minimize cumulative input.** Before the gate runs,
   oversized conversations are compacted (`compactConversationContext`) so the
   *estimate* that gets reserved is smaller; delegated children receive a bounded
   briefing packet (`buildAssignmentContext`) instead of a raw parent replay
   (`src/index.ts:454–472`).
4. **Artifact externalisation bounds tool output.** Tool results larger than
   `maxToolOutputChars` are archived in the ArtifactStore and replaced in-context by a
   compact reference marker, so large outputs never flood the context window
   (`externalizeToolOutput`, `src/index.ts:792–815`).

```
                    ┌──────────────────────────────────────────────────────────┐
                    │                  OpenCode plugin (src/index.ts)          │
                    └──────────────────────────────────────────────────────────┘
                                        │
   chat.message (before model call)     │   message.updated (assistant msg)
   ┌────────────────────────────────────▼───────────────────────────────────┐
   │  1. compactConversationContext     │  5. reconcileUsage → commitUsage   │
   │     (shrink history first)         │     release unused reservation,    │
   │  2. beforeDispatch                 │     charge billable, warn/stop     │
   │     serializeEstimate(message)     │                                    │
   │  3. reserveRequest (atomic)  ──────┼────▶  TokenBudgetController         │
   │     need = clamp(input)            │        run / agent / assignment     │
   │            + clamp(maxOutput)      │        committedKeys (idempotent)   │
   │  4. allowed? ── no ─▶ throw        │        FileTokenUsageStore (.jsonl) │
   └────────────────────────────────────┴───────────────────────────────────┘
                                        │
   tool.execute.after (large output)    │   session.error / session.completed
   ┌────────────────────────────────────▼───────────────────────────────────┐
   │  externalizeToolOutput ──▶ ArtifactStore (content-hash, LRU, self-heal) │
   │  marker replaces output in context; fdx-context read_artifact retrieves  │
   │  onSessionEnd → cancelSession → release pending reservations + children │
   └─────────────────────────────────────────────────────────────────────────┘
```

Source map:

| Concern | Source |
|---|---|
| Authoritative controller | `token-budget-controller.ts` (header, `reserveRequest`, `commitUsage`) |
| Plugin-facing runtime | `token-budget-runtime.ts` (`beforeDispatch`, `reconcileUsage`, `onSessionEnd`) |
| Compaction before gate | `src/index.ts:454–472` |
| Externalisation hook | `src/index.ts:792–815` |
| Artifact store | `artifact-store.ts` |

---

## 2. Budget Hierarchy: run → agent/session → assignment → request

### 2.1 Levels

| Level | Represented by | Scope |
|---|---|---|
| **run** | `RunBudgetState` (`token-budget-controller.ts:125–133`) | One ceiling for the whole orchestration: parent + every descendant + retries + reviewer/tester/recovery/summarisation. Identified by `runId`. |
| **agent/session** | `AgentBudgetState` (`token-budget-controller.ts:106–114`) | One per session (`sessionId`), registered via `registerSession`. Root sessions own the full run ceiling; child sessions are capped by `childTotal`. |
| **assignment** | `AssignmentBudgetState` (`token-budget-controller.ts:116–123`) | One per delegated assignment, deduplicated by identity; tracks consumed/reserved and status (`active`/`completed`/`superseded`/`cancelled`). |
| **request** | `ReservationRecord` (`token-budget-controller.ts:147–161`) | One per model invocation attempt: `estimatedInput`, `maxOutput`, `claimed`, status. |

### 2.2 Parent and child sessions share one run

`TokenBudgetRuntime` keeps two maps: `controllers` (runId → controller) and
`runForSession` (sessionID → runId) (`token-budget-runtime.ts:69–70`).

- `getControllerForSession(ctx)` first checks `runForSession`, otherwise resolves the
  run via `lookupRunId(ctx)` and lazily creates (or restores) the controller for that
  run (`token-budget-runtime.ts:110–135`).
- `lookupRunId(ctx)` resolves: direct mapping → parent session's run → **parentID as
  the run key** (so siblings stay coherent within one parent run) → the session's own
  ID for a root (`token-budget-runtime.ts:137–148`).
- Every session that joins a run is registered: `ctrl.registerSession(sessionID,
  agent, parentID)` (`token-budget-runtime.ts:133`).

### 2.3 Root vs child ceilings

`registerSession` (`token-budget-controller.ts:268–286`):

```ts
const ceiling = parentSessionId ? Math.min(this.config.childTotal, this.run.ceiling) : this.run.ceiling
```

- **Root sessions** (no parent) own the **full run ceiling**.
- **Child sessions** are capped by `childTotal` (never above the run ceiling), so
  delegated work cannot starve the orchestrator's own budget. The integration test
  `tests/integration/token-budget.test.ts:46–63` proves a child is blocked with
  `CHILD_BUDGET_EXHAUSTED` while the run still has room.

### 2.4 `remainingRun()`

```ts
remainingRun(): number {
  return Math.max(0, this.run.ceiling - this.run.consumed - this.run.reserved)
}
```

(`token-budget-controller.ts:574–576`). Remaining budget = ceiling minus everything
already consumed minus everything currently reserved by in-flight requests. This is
the number surfaced in `PreDispatchResult.remainingRun` and every rejection reason.

### 2.5 Assignment dedup

`assignmentIdentity(runId, type, agent, scope, sha)` joins five fields with `|`
(`token-budget-controller.ts:295–297`). `ensureAssignment` reuses an **active**
assignment with the same identity instead of creating a duplicate; `completeAssignment`
/ `supersedeAssignment` move it out of the reusable set
(`token-budget-controller.ts:299–331`).

### 2.6 Lifecycle sequence (dispatch → reconcile → end)

```ts
// ── dispatch (per model request) ─────────────────────────────────────────
const pre = await runtime.beforeDispatch(ctx, message, { maxOutputTokens })
//   serializeEstimate(message) → estimatedInputTokens
//   controller.reserveRequest({ ... })   // atomic under InProcessMutex
//   allowed=false → BUDGET_EXHAUSTED | CHILD_BUDGET_EXHAUSTED
//                  | RUN_TERMINAL:…      | SESSION_TERMINAL:…
//   allowed=true  → reservation recorded, run.reserved += claimed

// ── reconcile (per assistant message) ────────────────────────────────────
await runtime.reconcileUsage(ctx, { id: msg.id, tokens, cost })
//   commitUsage({ messageId: msg.id, reservationId, usage })
//   idempotent per messageId/requestId (committedKeys)
//   releasedUnused = max(0, claimed − billable); run.reserved −= claimed
//   run.consumed   += billable   // billable = input+output+reasoning+cacheRead+cacheWrite
//   warning fires once at warningThreshold·ceiling
//   hard stop at hardStopThreshold·ceiling → terminal + cancelAllReservations

// ── end (per session) ────────────────────────────────────────────────────
await runtime.onSessionEnd(ctx, reason)
//   cancelSession → mark session + descendants terminal
//   cancel still-“reserved” reservations (persist status “cancelled”)
//   pending slots for the session dropped
```

Sources: `token-budget-runtime.ts:155–253`, `token-budget-controller.ts:340–548`,
integration test `tests/integration/token-budget.test.ts:12–44`.

---

## 3. Pre-Dispatch Gate

### 3.1 `beforeDispatch` flow

`TokenBudgetRuntime.beforeDispatch` (`token-budget-runtime.ts:155–194`):

1. Resolve the controller for the session (`getControllerForSession`).
2. `serializeEstimate(message)`: `JSON.stringify(message ?? {})` → `Buffer.byteLength`
   (UTF-8) → `estimateTokensFromBytes(bytes) = Math.ceil(bytes / 4)`
   (`token-budget-runtime.ts:59–66`, `token-budget.ts:80–81`).
3. Call `ctrl.reserveRequest(...)` with:
   - `estimatedInputTokens: estimate` (the serialized message only),
   - `maxOutputTokens: opts?.maxOutputTokens` (optional),
   - `requestId: req-${sessionID}-${randomUUID()}`.
4. If disabled → `{ allowed: true, disabled: true }`. If rejected → fire `onTerminal`
   and return `{ allowed: false, reason }`. If allowed → push a FIFO pending slot
   (`MAX_PENDING_PER_SESSION = 8`, oldest dropped) and fire `onWarning` if the run
   already crossed the warning threshold (`token-budget-runtime.ts:57, 178–193`).

### 3.2 The controller adds `maxOutputTokens` itself — never double-add

The runtime passes **only the message estimate** as `estimatedInputTokens`. The
controller computes `need`:

```ts
const estimatedInput = clamp(finiteOrZero(opts.estimatedInputTokens, 0), 0, this.config.maxRequestInputTokens)
const maxOutput     = clamp(finiteOrZero(opts.maxOutputTokens, 0), 0, this.config.maxRequestOutputTokens)
const need = estimatedInput + maxOutput
```

(`token-budget-controller.ts:364–366`). The runtime comment is explicit: *"only the
message estimate is passed as estimatedInputTokens — the controller adds
maxOutputTokens itself (need = input + output). Counting it here too would
double-charge every reservation."* (`token-budget-runtime.ts:161–163`). Callers must
never pre-add output to `estimatedInputTokens`.

> **Note on the current wiring:** `src/index.ts:484–487` calls `beforeDispatch` with
> only `model` and `provider`, so the output term is `0` in production today; the
> `maxOutputTokens` API exists and is exercised by tests
> (`tests/services/token-budget-runtime.test.ts`, `tests/integration/token-budget.test.ts`).

### 3.3 Atomic reservation under `InProcessMutex`

All mutations go through `this.mutex.run(...)`. `InProcessMutex`
(`token-budget-controller.ts:163–180`) serialises every `reserveRequest`,
`commitUsage`, `terminate`, and `cancelSession` on a promise tail — no two budget
mutations interleave, eliminating check-then-act oversubscription
(`reserveRequest` → `reserveRequestSync` at `token-budget-controller.ts:340–344`).

### 3.4 Rejection paths

`reserveRequestSync` rejects in this order (`token-budget-controller.ts:344–378`):

| Order | Condition | `reason` returned | Notes |
|---|---|---|---|
| 1 | `!config.enabled` | — | Not a rejection: returns `{ allowed: true, disabled: true }`, records a `disabled` record |
| 2 | `run.terminal` | `RUN_TERMINAL:<reason>` | e.g. `RUN_TERMINAL:budget_exhausted` |
| 3 | agent (session) terminal | `SESSION_TERMINAL:<reason>` | session already cancelled/terminal |
| 4 | `need > remainingRun()` | `BUDGET_EXHAUSTED` | run ceiling reached |
| 5 | `need > remainingAgent` | `CHILD_BUDGET_EXHAUSTED` | child ceiling reached (`remainingAgent = agent.ceiling − agent.consumed − agent.reserved`) |

Every rejection appends a `rejected` record to the store
(`token-budget-controller.ts:354, 361, 370–371, 376–377`). The plugin translates a
rejection into a thrown error:

```ts
throw new Error(`TOKEN_BUDGET_EXCEEDED: ${budget.reason ?? "budget exhausted"} (run ${budget.runId}, remaining ${budget.remainingRun})`)
```

(`src/index.ts:488–492`). When the run is already terminal, the controller returns the
same rejection for every subsequent request, so the gate is a hard, permanent stop.

A non-mutating read-only variant, `canDispatch`, mirrors the same checks
(`token-budget-controller.ts:578–591`).

---

## 4. Reconciliation (commitUsage)

`commitUsage` (`token-budget-controller.ts:413–503`) is the single place actual
provider usage becomes authoritative. The plugin calls it from
`reconcileUsage` on `message.updated` for assistant messages carrying real `tokens`
and `cost` (`token-budget-runtime.ts:200–243`, `src/index.ts:988–1010`).

### 4.1 Idempotency per messageId/requestId

```ts
const dedupKey = opts.messageId ?? opts.requestId
if (dedupKey && this.committedKeys.has(dedupKey)) {
  return { committed: false, releasedUnused: 0, remainingRun, warningFired, terminal, billable: 0 }
}
```

(`token-budget-controller.ts:418–428`). `committedKeys` is seeded from durable records
on restore, so re-delivered events (duplicate `message.updated`) never double-charge.
The runtime passes `messageId: msg.id`, so dedup is keyed on the assistant message id.

### 4.2 Release unused reservation, then charge billable

1. **Release:** if the reservation is still `reserved`, mark it `committed`, then
   `releasedUnused = max(0, reservation.claimed − usage.billable)` and subtract the
   **full claimed amount** from `run.reserved` / agent / assignment. `releasedUnused`
   accumulates on the run for telemetry (`token-budget-controller.ts:434–446`).
2. **Charge:** `run.consumed += usage.billable`, mirrored to the agent and the
   assignment (`token-budget-controller.ts:448–453`).
3. Append the `usage` record to the store, add the dedup key, then evaluate warning
   and hard-stop.

### 4.3 Billable definition

```ts
const billable = input + output + reasoning + cacheRead + cacheWrite
```

(`normalizeUsage`, `token-budget-controller.ts:200–209`). Cached-token fields are kept
distinct from ordinary uncached input and **never double-counted** — they are simply
added once each. `cost` is carried separately as `estimatedCost` (only when a finite,
non-negative number) and does **not** affect token accounting.

### 4.4 Conservative fallback when the provider omits usage

```ts
const fallbackInput = reservation?.estimatedInput ?? 0
const usage = normalizeUsage(opts.usage, fallbackInput)
```

(`token-budget-controller.ts:430–432`). `normalizeUsage` applies `finiteOrZero` to each
field, so `undefined`/`NaN`/negative values fall back — input to the **reserved
estimate**, everything else to `0`. A provider that omits usage data is therefore
charged at least what was reserved: accounting never under-reports.

### 4.5 Warning fires once

```ts
if (!this.run.warningFired && this.run.consumed >= this.config.warningThreshold * this.run.ceiling) {
  this.run.warningFired = true
  this.store.append(runId, { kind: "warning", runId, at: Date.now() })
}
```

(`token-budget-controller.ts:479–484`). The warning is emitted once per run (the flag
is part of `RunBudgetState` and is recovered on restart). `TokenBudgetRuntime` surfaces
it through `onWarning` (`token-budget-runtime.ts:236–239`), wired to `appLog(..., "warn")`
in `src/index.ts:282–284`.

### 4.6 Hard stop at threshold cancels all reservations

```ts
if (!terminal && this.run.consumed >= this.config.hardStopThreshold * this.run.ceiling) {
  terminal = { reason: "budget_exhausted", at: Date.now() }
  this.run.terminal = terminal
  this.store.append(runId, { kind: "terminal", ... })
  this.cancelAllReservations("budget_exhausted")
}
```

(`token-budget-controller.ts:487–493`). Crossing the hard-stop threshold flips the run
terminal **and** cancels every still-`reserved` reservation
(`cancelAllReservations`, `token-budget-controller.ts:550–561`), persisting each status
change so a rebuild never resurrects them as reserved slack. From that point every
`beforeDispatch` returns `RUN_TERMINAL:budget_exhausted`.

`terminate(reason)` is the explicit variant: marks the run terminal, appends the
terminal record, cancels all reservations, and marks every registered agent terminal
(`token-budget-controller.ts:507–517`).

### 4.7 Session end releases pending reservations

`TokenBudgetRuntime.onSessionEnd` → `ctrl.cancelSession(sessionID, reason)`
(`token-budget-runtime.ts:246–253`). `cancelSession` marks the session **and its
direct descendants** terminal, then cancels reservations owned by that session subtree,
persisting each `cancelled` status (`token-budget-controller.ts:519–548`). Pending FIFO
slots for the session are dropped. The plugin wires this on `session.error` and
`session.completed` (`src/index.ts:1011–1023`).

---

## 5. Persistence & Recovery

### 5.1 Append-only JSONL

Durable accounting lives in an append-only JSONL file per run:

```
<persistDir>/<runId>.jsonl
```

`FileTokenUsageStore` (`token-usage-store.ts:86–137`); the run id is sanitised for the
filename (`/runId.replace(/[^A-Za-z0-9._-]/g, "_")/`, `token-usage-store.ts:93–96`).
Four record kinds are appended (`token-usage-store.ts:58–63`):

| kind | Written when |
|---|---|
| `reservation` | every `reserveRequest` (allowed or rejected) and every status change to `cancelled` |
| `usage` | every successful `commitUsage` (one per dedup key) |
| `warning` | the single warning event per run |
| `terminal` | hard stop / explicit terminate |

Appends are synchronous and fail-silent: *"Accounting must never crash the runtime. If
persistence fails, the in-memory counters remain authoritative for this process."*
(`token-usage-store.ts:104–110`).

### 5.2 Default location: `.flowdeck/token-usage`

`TokenBudgetRuntime.fromConfig` defaults `persistDir` to
`join(directory, ".flowdeck", "token-usage")` when the config does not specify one
(`token-budget-runtime.ts:86–100`). The whole `.flowdeck/` directory is git-ignored
(`.gitignore:160`). The artifact store sits beside it at
`.flowdeck/artifacts` (`src/index.ts:272`).

### 5.3 `rebuildFromEntries` — deterministic replay

`rebuildFromEntries(entries, runId)` (`token-usage-store.ts:174–244`) is shared by the
file and in-memory stores. Determinism rules:

- **Later records win per dedup key.** The last `usage` entry per
  `messageId ?? requestId ?? reservationId` is authoritative; `consumed` sums only the
  winning records — duplicates never double-count (`token-usage-store.ts:203–207, 232–233`).
- **Latest reservation status wins.** Each reservation's `claimed` and latest durable
  `status` are tracked. `reserved` = sum of claimed where the latest status is
  `reserved`, minus reservations later committed (their usage is already in
  `consumed`). A reservation that was **cancelled after being reserved nets to zero**
  (`token-usage-store.ts:219–230`).
- **Terminal:** the last terminal entry wins (a later one overrides an earlier one).
- **Warning:** any warning entry sets `warningFired = true`.

### 5.4 Truncated trailing line tolerance

`FileTokenUsageStore.read` splits on newlines, drops empty lines, and `JSON.parse`s
each line, discarding entries that fail to parse (`token-usage-store.ts:114–132`). A
partially-written final line (crash mid-append) is therefore tolerated without losing
the run.

### 5.5 Restart flow: `TokenBudgetController.restore`

```ts
static restore(config, runId, store): TokenBudgetController {
  const ctrl = new TokenBudgetController(config, { store, runId })
  const rebuilt = store.rebuild(runId)
  ctrl.run.consumed = rebuilt.consumed
  ctrl.run.reserved = rebuilt.reserved
  ctrl.run.releasedUnused = rebuilt.releasedUnused
  ctrl.run.warningFired = rebuilt.warningFired
  ctrl.run.terminal = rebuilt.terminal
  // records replayed; committedKeys re-seeded so dedup survives restarts
}
```

(`token-budget-controller.ts:246–264`). The runtime triggers recovery lazily in
`getControllerForSession`: it rebuilds the store and restores only when the run has
`consumed > 0 || reserved > 0 || terminal`; otherwise it starts a fresh controller on
the same run id (`token-budget-runtime.ts:118–126`). The integration test proves a
fresh runtime over the same persist dir recovers `consumed` and keeps enforcing
(`tests/integration/token-budget.test.ts:65–91`).

> `persist()` is intentionally a no-op flush hook. It does **not** write a terminal
> record, because a "flush" terminal would be replayed as a real terminal state on
> rebuild and block dispatch (`token-budget-controller.ts:613–617`).

---

## 6. Context Scoping (buildAssignmentContext)

`buildAssignmentContext` (`context-scoping.ts:42–71`) produces the **entire** prompt a
delegated child receives. The plugin calls it when constructing the `task` tool's
child prompt (`src/index.ts:614–625`).

### 6.1 What a child receives

The packet is built by `formatContextPacket` (`token-optimizer-service.ts:28–58`),
which guarantees the handoff stays strictly under **400 tokens (~1600 characters)**
(`MAX_CONTEXT_PACKET_TOKENS = 400`, `MAX_CONTEXT_PACKET_CHARS = 1600`):

```
## Orchestrator Context
Target: <target>
Blast radius: <blastRadius>          (optional)
Patterns: <up to 3 patterns>          (optional)
Prior lessons: <priorLessons>         (optional)
Constraints: <constraints>            (defaults to "Surgical changes only. Verify changes with tests before completion.")
Stage: <stage>                        (defaults to "execute")

## Assignment
<assignment>

Git Commit/SHA: <gitCommit>           (optional)
Relevant files: <files…>              (optional)
Acceptance Criteria:
- <criterion>                         (optional)
Externalized Artifacts: <ids…>        (optional)
```

So the child gets: **objective** (assignment + target), **contract** (stage,
constraints, patterns), **repository anchor** (git SHA), **navigation hints** (relevant
files), **definition of done** (acceptance criteria), **execution state references**
(externalized artifact ids), plus a token estimate and the guarantee flag:

```ts
return { prompt, estimatedTokens: estimateTokensFromBytes(bytes), parentConversationExcluded: true }
```

(`context-scoping.ts:66–70`).

### 6.2 What a child must NOT receive

- **The full parent conversation** is never replayed — `parentConversationExcluded`
  is a compile-time `true` on the result type (`context-scoping.ts:33`).
- **Unrelated tool output** is not copied in. Large outputs referenced by a child are
  externalised to the ArtifactStore and handed over as **stable artifact ids** only
  (section 8).

---

## 7. Context Compaction (compactConversationContext)

### 7.1 Threshold behavior

```ts
export function shouldCompact(estimatedTokens, thresholdTokens): boolean {
  return estimatedTokens > thresholdTokens
}
```

(`context-scoping.ts:125–127`). `compactConversationContext`
(`context-scoping.ts:361–438`) compacts only when the estimated replay exceeds
`thresholdTokens` **and** the message list has more than 3 turns; otherwise it returns
the messages untouched with `compacted: false`.

In the plugin the compaction runs **before the budget gate** so the reservation size
reflects the shrunken history: *"Compact intermediate conversation turns when token
footprint exceeds the configured threshold — runs before the budget gate to reduce
reservation size"* (`src/index.ts:454–472`, `compactThresholdTokens` from config).

### 7.2 What survives

- The **system message** (index 0 with `role === "system"`) is preserved verbatim.
- The **most recent 2–4 active turns** survive (`recentCount = min(4, max(2,
  floor(len/3)))`).
- Everything obsolete is compressed into a single `user` turn headed
  `## Compacted Execution State` (`COMPACT_MARKER`, `context-scoping.ts:173`) with
  Initial Goal, Acceptance Criteria, Architectural Constraints, Verified Facts &
  Decisions, Unresolved Failures, Files Touched / Relevant, Externalized Artifacts,
  and an incremented Compaction Phase (`formatCompactionSummary`,
  `context-scoping.ts:320–346`).

### 7.3 Deterministic, non-nesting

- Existing summary blocks in obsolete turns are **parsed back** into the accumulator
  (`parseCompactedStateFromText`, `context-scoping.ts:205–266`) so knowledge carries
  forward across repeated compactions.
- Turns in the recent window that already contain the compact marker are **filtered
  out** (`context-scoping.ts:390–395`) — a prior summary can never be nested inside a
  new one. The result is deterministic given the same input: set-ordered fields, caps,
  and `reductionRatio = max(0, 1 − compactedTokens / originalTokens)`.

### 7.4 Verified-facts cap — Conclusion excluded

Facts are collected from lines matching `/Decision:|Verified:|Passed:/` up to a cap of
**10** (`context-scoping.ts:294–296`). The comment is explicit: *"Conclusion: lines are
turn summaries, not facts or decisions — excluding them keeps the cap for real
signals."* Other caps: acceptance criteria **10**, architectural constraints **5**,
unresolved failures **5**, files **15**, externalized artifact ids **20**
(`context-scoping.ts:294–315`). Unresolved requirements (`Unresolved Failures`, capped
at 5) and acceptance criteria (capped at 10) are deliberately **retained** across
compactions — the summary block is the child's execution state, not just a log
(`context-scoping.ts:229–243, 297–303`).

Result fields (`context-scoping.ts:155–171`): `compacted`, `originalTokens`,
`compactedTokens`, `compactionCount`, `retainedFactsCount`, `retainedDecisionsCount`
(Decision-only subset), `retainedCriteriaCount`, `retainedFilesCount`, `reductionRatio`.

---

## 8. Tool-Output Externalisation

### 8.1 Trigger and thresholds

In `tool.execute.after`, for string fields named `output`, `result`, or `content`,
when the string length exceeds `maxToolOutputChars` (default **8 000** chars), the
output is externalised (`src/index.ts:792–815`).

`externalizeToolOutput` (`context-scoping.ts:86–119`):

- Under budget → returns the text unchanged (`truncated: false`).
- Over budget with an ArtifactStore → stores the full content and returns a compact
  marker (below).
- Over budget **without** a store → returns `text.slice(0, maxChars − 3) + "..."`
  (a hard truncation, `retainedChars = max(0, maxChars − 3)`).

### 8.2 ArtifactStore properties

`ArtifactStore` (`artifact-store.ts:82–312`), instantiated once per plugin run at
`.flowdeck/artifacts` (`src/index.ts:272`, `getArtifactStore` singleton at
`artifact-store.ts:316–321`):

- **Content-hash IDs** — `id = art-<type-with-dashes>-<sha256(content).slice(0,12)>`
  (`artifact-store.ts:120–121`); identical content produces the identical id.
- **Deduplication** — in-memory and on-disk hits return the existing artifact without
  rewriting (`artifact-store.ts:123–141`).
- **LRU in-memory eviction** — `maxInMemory` default **200**; `insertionOrder` tracks
  recency; `evictMemoryIfNeeded` drops the oldest (`artifact-store.ts:84–85, 288–311`).
- **Disk fallback + pruning** — JSON files `<id>.json`; `pruneDisk` removes oldest-by-
  mtime files when count exceeds `maxDiskFiles` (default **1000**), run every 50 stores
  (`artifact-store.ts:158–172, 221–252`).
- **Integrity check** — `loadFromDisk` validates structure (id/content/hash strings)
  and, for hash-based ids, verifies `sha256(content)` starts with the id's 12-hex
  suffix (`artifact-store.ts:256–286`).
- **Self-heal** — corrupted or tampered files are **deleted** on read so they cannot
  poison the cache (`artifact-store.ts:281–284`). File-write failures are non-fatal
  (in-memory is authoritative).

### 8.3 Stable references and retrieval

The marker returned to the model is stable and self-describing
(`context-scoping.ts:106`):

```
[Externalized Artifact: art-tool-output-<hash12> (type: tool_output, length: <N> chars)]
Tool: <toolName>
Summary:
<buildSummary(content) — error lines or head/tail snippet, ≤ 300 chars>

To view full content, call fdx-context with action:"read_artifact" and artifact_id:"art-tool-output-<hash12>".
```

Retrieval: `fdx-context` with `action: "read_artifact"` is handled natively even
without the Rust CLI — `nativeContextFallback` → `getArtifactStore().get(artifact_id)`
→ returns `[Artifact: id | Tool: toolName | Length: chars]\n<content>`, or the
placeholder `[Artifact "<id>" not found]` (`src/tools/fdx.ts:463–478`,
`src/tools/fdx-shared.ts:595–614`).

---

## 9. Telemetry

### 9.1 `getSnapshot`

`TokenBudgetController.getSnapshot` (`token-budget-controller.ts:593–605`) returns a
`TokenBudgetSnapshot` (`token-budget-controller.ts:135–145`):

| Field | Type | Meaning |
|---|---|---|
| `runId` | string | run identity |
| `profile` | string | active budget profile name |
| `enabled` | boolean | budget enforcement on/off |
| `run` | `RunBudgetState` | ceiling, consumed, reserved, releasedUnused, warningFired, terminal |
| `agents` | `AgentBudgetState[]` | per-session ceilings, consumed, reserved, terminal |
| `assignments` | `AssignmentBudgetState[]` | per-assignment consumed/reserved/status |
| `remainingRun` | number | `remainingRun()` |
| `warningThreshold` / `hardStopThreshold` | number | configured fractions |

`TokenBudgetRuntime.getSnapshot(sessionID)` resolves the session's run controller and
returns its snapshot, or `null` for an unknown session (`token-budget-runtime.ts:260–265`).

### 9.2 Warning / terminal callbacks

`TokenBudgetRuntimeOptions` accepts `onWarning` and `onTerminal`
(`token-budget-runtime.ts:31–34`). Wired in `src/index.ts:280–288` to `appLog(..., "warn")`:

- `onWarning`: `Token budget warning: run <runId> used <consumed> of <ceiling>`
  — fired from `beforeDispatch` when the run already crossed the warning threshold, and
  from `reconcileUsage` after a commit crosses it (`token-budget-runtime.ts:187–189, 236–239`).
- `onTerminal`: fired when `beforeDispatch` rejects and when `reconcileUsage` observes
  a terminal run (`token-budget-runtime.ts:190–192, 240–242`).

### 9.3 Usage records

`getUsageRecords()` returns the in-memory `TokenUsageRecord[]` replay
(`token-budget-controller.ts:607–609`). Each record (`token-usage-store.ts:21–56`)
carries run/session/agent/assignment identity, `requestId`, `reservationId`,
`messageId`, `attempt`, the five token fields, `billable`, optional `estimatedCost`,
`terminationReason`, `status` (`reserved | committed | released | rejected | cancelled |
disabled`), and `recordedAt`. Provider fields are normalised at the boundary.

---

## 10. Configuration Reference

`resolveTokenBudgetConfig(overrides?)` (`token-budget-config.ts:136–190`) is the single
resolver. Precedence: **environment variable → config override (`tokenBudget` section)
→ profile → built-in default**. The config section is read from the FlowDeck config
file (`loadFlowDeckConfig`, `src/config/agent-models.ts:126–150` — candidates
`.flowdeck.jsonc`, `.flowdeck.json`, `.opencode/flowdeck.jsonc`, `.opencode/flowdeck.json`,
global `~/.config/opencode/flowdeck.json`), key `tokenBudget`
(`src/config/schema.ts:57–58`, allow-listed in `VALID_CONFIG_KEYS`,
`src/config/agent-models.ts:97`).

| Key (`tokenBudget` section) | Env var | Default | Validation / behavior |
|---|---|---|---|
| `enabled` | `FLOWDECK_TOKEN_BUDGET_ENABLED` | `true` | boolean (`envBool`); `false` makes every reservation `disabled`/allowed |
| `profile` | `FLOWDECK_TOKEN_BUDGET_PROFILE` | `"normal"` | one of `small`, `normal`, `audit`, `deep-audit`; supplies run/child totals |
| `runTotal` | `FLOWDECK_TOKEN_BUDGET_RUN_TOTAL` | profile value | `assertPositive` (finite, > 0) |
| `childTotal` | `FLOWDECK_TOKEN_BUDGET_CHILD_TOTAL` | profile value | `assertPositive`; **must not exceed `runTotal`** else `TokenBudgetConfigError` |
| `warningThreshold` | `FLOWDECK_TOKEN_BUDGET_WARNING` | `0.8` | fraction in `(0, 1]`; must be ≤ `hardStopThreshold` |
| `hardStopThreshold` | `FLOWDECK_TOKEN_BUDGET_HARD_STOP` | `1.0` | fraction in `(0, 1]` |
| `maxRequestInputTokens` | `FLOWDECK_TOKEN_BUDGET_MAX_REQUEST_INPUT` | `200_000` | `assertPositive`; used as the upper clamp on estimated input at reservation time |
| `maxRequestOutputTokens` | `FLOWDECK_TOKEN_BUDGET_MAX_REQUEST_OUTPUT` | `32_000` | `assertPositive`; upper clamp on reserved output |
| `maxToolOutputChars` | `FLOWDECK_TOKEN_BUDGET_MAX_TOOL_OUTPUT` | `8_000` | `assertPositive`; externalisation threshold (chars) |
| `compactThresholdTokens` | `FLOWDECK_TOKEN_BUDGET_COMPACT_THRESHOLD` | `120_000` | `assertPositive`; compaction trigger (tokens) |
| `persistDir` | — (overrides only) | `""` | runtime defaults to `<project>/.flowdeck/token-usage` when empty |

Profiles (`BUDGET_PROFILES`, `token-budget-config.ts:59–64`):

| Profile | `runTotal` | `childTotal` |
|---|---|---|
| `small` | 250 000 | 80 000 |
| `normal` (default) | 600 000 | 180 000 |
| `audit` | 1 500 000 | 350 000 |
| `deep-audit` | 3 000 000 | 600 000 |

Validation **throws** (`TokenBudgetConfigError`) rather than silently clamping for
run/child/threshold values (`assertPositive`, `assertFraction`,
`token-budget-config.ts:86–96`). The per-request **clamping** happens at reservation
time: `clamp(estimatedInput, 0, maxRequestInputTokens)` and
`clamp(maxOutput, 0, maxRequestOutputTokens)` (`token-budget-controller.ts:364–365`).
Unparseable env values also throw (`envNumber`, `envBool`, `envProfile`,
`token-budget-config.ts:98–126`).

---

## 11. Provider Integration Guidance

A new provider is accounted correctly if its assistant messages carry usage in the
shape `reconcileUsage` and `commitUsage` expect:

```ts
msg: {
  id: string
  tokens?: {
    input?: number        // uncached input tokens
    output?: number       // output tokens (excluding reasoning)
    reasoning?: number    // reasoning tokens where exposed
    cache?: { read?: number; write?: number }
  }
  cost?: number           // estimated monetary cost, finite and >= 0
  modelID?: string
  providerID?: string
  error?: unknown
}
```

(`token-budget-runtime.ts:200–209`). Rules the controller applies:

1. **Separate cache from input.** Report cached input under `cache.read` /
   `cache.write`, never folded into `input` — cached tokens are counted exactly once,
   in their own field, and never double-counted (`token-budget-controller.ts:195–209`).
2. **Report output excluding reasoning.** `output` and `reasoning` are distinct fields
   and both count toward `billable`.
3. **Omitting usage is safe but conservative.** If `tokens` is absent, input falls
   back to the reserved estimate; the provider is charged at least what was reserved
   (`token-budget-controller.ts:430–432`).
4. **`cost` is advisory.** It is stored as `estimatedCost` only when finite and
   non-negative; it never changes token accounting (`token-budget-controller.ts:207`).
5. **Reconcile once per message id.** Emit `tokens` on the final assistant message
   update; duplicate events are deduplicated by `messageId` (`token-budget-controller.ts:418–428`).

A provider that cannot report `reasoning` or `cache` should simply omit those fields —
they fall back to 0.

---

## 12. Known Limitations & Failure Modes

| Scenario | Behaviour |
|---|---|
| **Provider omits usage** | `commitUsage` falls back input to the reserved estimate; billable never under-reports. No estimate is available for an *unreserved* commit (reservation lookup miss) — input falls back to 0 (`token-budget-controller.ts:430–432`). |
| **Aborted stream (reservation never reconciled)** | The reservation stays `reserved` and holds slack until the session ends; `onSessionEnd` → `cancelSession` releases the session subtree's reservations (`token-budget-runtime.ts:246–253`, `token-budget-controller.ts:519–548`). A hard stop also cancels all reservations (`token-budget-controller.ts:487–493`). |
| **Crash between reserve and reconcile** | On restart, `rebuildFromEntries` replays the durable log: the reservation replays as `reserved` (slack held until session end cancels it); a later-persisted `cancelled` status nets it to zero; a committed usage record wins per dedup key (`token-usage-store.ts:174–244`). The reservation is not re-attached to the in-memory pending FIFO after restart — it is released by session end. |
| **Duplicate `message.updated` events** | `committedKeys` (re-seeded from durable records on restore) makes `commitUsage` idempotent per `messageId`/`requestId` (`token-budget-controller.ts:418–428`). |
| **Persistence write failure** | Appends are fail-silent; in-memory counters remain authoritative for the process (`token-usage-store.ts:104–110`). A partially written trailing line is ignored on read. |
| **Concurrent agents** | `InProcessMutex` serialises all budget mutations in-process — no check-then-act oversubscription (`token-budget-controller.ts:163–180`). (The mutex is per-process; multi-process sharing of one run log is outside the current design.) |
| **Hard truncation without an artifact store** | `externalizeToolOutput` without a store truncates to `maxChars − 3`; the tail is lost (`context-scoping.ts:107–110`). With the store, full content is retrievable via `fdx-context read_artifact`. |
| **Artifact eviction / corruption** | LRU eviction (memory) and disk pruning (oldest first) can remove an artifact; retrieval then returns `[Artifact "<id>" not found]` (`fdx-shared.ts:611`). Corrupt files self-heal by deletion (`artifact-store.ts:281–284`). |
| **Compaction under 4 turns** | `compactConversationContext` refuses to compact when `messages.length <= 3` — tiny conversations are never rewritten (`context-scoping.ts:363`). |
| **Session without a registered run** | `getSnapshot(sessionID)` returns `null`; `onSessionEnd` is a no-op — no release is attempted for unknown runs (`token-budget-runtime.ts:247–249, 260–265`). |
| **Disabled budget** | Every reservation returns `{ allowed: true, disabled: true }`; a `disabled` record is appended; no gating occurs (`token-budget-controller.ts:348–351`). |

---

*All claims in this document were verified against the source at HEAD `ecde6d7`
(branch `fix/token-budget-control`). Per-section sources are cited inline; the primary
files are `src/services/token-budget-controller.ts`, `src/services/token-budget-runtime.ts`,
`src/services/token-usage-store.ts`, `src/services/context-scoping.ts`,
`src/services/artifact-store.ts`, `src/config/token-budget-config.ts`, and the wiring in
`src/index.ts`.*
