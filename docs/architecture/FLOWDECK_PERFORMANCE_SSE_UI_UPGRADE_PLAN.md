# FlowDeck Performance, SSE v2, and Live Orchestration UI Upgrade Plan

## Status & Baseline

- **Owner:** Dev 1 — Performance, SSE v2, and Live Orchestration UI Lead
- **Branch:** `feat/performance-sse-ui-foundation`
- **Base SHA:** `5809fcf1230ff349ff0d7f5b53ed75403f44573b` (FlowDeck `main` v1.0.3)
- **Frozen Orchestration Harness:** FlowDeck **v1.0.3**
- **Architecture Baseline:** `NEXT_GEN_ARCHITECTURE_v0.2.6.md`
- **Canonical Schema:** `schema-v0.2.6.sql`
- **Merge Policy:** Keep PR open and unmerged. No merge without explicit human approval.

The FlowDeck v1.0.3 harness is frozen for the entire campaign. FlowDeck v1.0.3 supervises all work, recording main session, specialist sessions, lifecycle stages, checkpoints, decisions, tool calls, token usage, execution time, failures, retries, recovery, stability defects, and final verification.

---

## Priority & Strategic Realignment

The upgrade roadmap is reordered. Dev 1 implements **Priority 0 / Wave 0 (SSE v2 and Live Orchestration UI)** before broader runtime enforcement, context optimization, FDX performance, model routing, and adaptive optimization.

```text
Priority 0 (Wave 0): SSE v2 Event Contract & Live Orchestration UI
  ├─ 1. Canonical SSE v2 event contract
  ├─ 2. Durable event projection and delivery (persist before deliver)
  ├─ 3. Reconnect, replay, sequence validation, and snapshots
  ├─ 4. Backpressure, coalescing, heartbeat, and bounded output
  ├─ 5. Parent/child cancellation propagation
  ├─ 6. Browser SSE connection manager & fetch client
  ├─ 7. Deterministic client-side run projection
  ├─ 8. Full live orchestration dashboard
  ├─ 9. Mobile, accessibility, and reduced-motion support
  ├─ 10. SSE & UI performance instrumentation
  └─ 11. Integration, reconnect, load, fault, and browser tests

Priority 1+ (Wave 1+): Subsequent Execution Upgrades (Post-SSE/UI Gate)
  ├─ Telemetry & Runtime Enforcement
  ├─ Context Optimization & Token Compaction
  ├─ FDX Performance & Rust Acceleration
  └─ Adaptive Model & Agent Routing
```

---

## Ownership & Implementation Surface

### Exact Dev 1 Ownership

- `src/orchestration/streaming/**`
- `src/orchestration/telemetry/streaming-*.ts`
- `src/better-harness/ui/**`
- `src/better-harness/transport/**` (where required for SSE transport)
- `tests/streaming/**`
- `tests/ui/**`
- `tests/e2e/**` (SSE & UI e2e tests)
- `docs/architecture/FLOWDECK_PERFORMANCE_SSE_UI_UPGRADE_PLAN.md`

### Architecture & Seams

- **Canonical Event Store:** Uses existing SQLite `events`, `event_outbox`, `event_deliveries`, `consumer_offsets`, and `dead_letter_events` in `schema-v0.2.6.sql`.
- **No Parallel Event Store:** Does not introduce a second database, second analytics store, or in-memory bypass for production paths.
- **Persist-Before-Deliver:** Domain events are committed to SQLite before SSE delivery.

---

## Performance Budgets & Target Metrics

| Metric | Target / Limit |
|---|---|
| Orchestration startup overhead | p95 < 300 ms |
| First visible run event in UI | p95 < 250 ms |
| Backend event-to-browser delivery | p95 < 100 ms |
| Browser event-to-render latency | p95 < 50 ms |
| Total backend-to-render latency | p95 < 150 ms |
| Unexplained UI silence limit | Max 5.0 seconds |
| Token update coalescing | Max 10–20 updates / sec |
| Metric update coalescing | Max 4 updates / sec |
| UI Frame Rate | 60 FPS under normal load |
| UI Memory Growth | Bounded (virtualized timeline, bounded stdout buffers) |
| Interrupted Run Recovery Rate | 100% replay accuracy on reconnect |

---

## Technical Architecture

### 1. Canonical SSE v2 Envelope

```typescript
export interface FlowDeckStreamEvent<TPayload = unknown> {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  runId: string;
  sessionId?: string;
  assignmentId?: string;
  occurredAt: string;

  type: FlowDeckEventType;
  stage: FlowDeckRunStage;
  importance: "debug" | "normal" | "important" | "critical";

  title: string;
  summary?: string;
  payload: TPayload;

  progress?: {
    completed: number;
    total: number;
    unit: "steps" | "checks" | "files" | "assignments";
  };

  metrics?: {
    elapsedMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCostUsd?: number;
    toolCalls?: number;
  };
}
```

### 2. Event Families (32 Event Types)

- **Run:** `run.created`, `run.started`, `run.resumed`, `run.cancelled`, `run.completed`, `run.failed`
- **Task:** `task.classifying`, `task.classified`
- **Contract:** `contract.created`, `contract.activated`
- **Stage:** `stage.entered`, `stage.progress`, `stage.completed`, `stage.blocked`
- **Plan:** `plan.created`, `plan.updated`, `plan.drift_detected`
- **Agent:** `agent.queued`, `agent.started`, `agent.progress`, `agent.completed`, `agent.failed`, `agent.cancelled`
- **Tool:** `tool.queued`, `tool.started`, `tool.output`, `tool.completed`, `tool.failed`, `tool.cancelled`
- **Model:** `model.queued`, `model.started`, `model.first_token`, `model.completed`, `model.failed`, `model.cancelled`
- **Verification:** `verification.started`, `verification.check_started`, `verification.check_completed`, `verification.completed`
- **Recovery:** `recovery.started`, `recovery.hypothesis_changed`, `recovery.completed`, `recovery.circuit_opened`
- **Evidence:** `evidence.created`
- **Approval:** `approval.required`, `approval.received`
- **System:** `metrics.updated`, `snapshot`, `heartbeat`

---

## Subtask Execution Roadmap (Dev 1 Tasks 1–9)

- **Task 1 — Repository Mapping & Plan Reorder:** Map existing code, establish baseline, update canonical plan (`docs/architecture/FLOWDECK_PERFORMANCE_SSE_UI_UPGRADE_PLAN.md`).
- **Task 2 — Canonical SSE Event Contract:** Runtime schemas, Zod validation, sequence rules, event envelope, serialization tests.
- **Task 3 — Durable SSE Backend:** Stream projector, broker, SSE endpoint (`GET /api/runs/:runId/events`), replay service, snapshot service, heartbeat, backpressure, cancellation controller.
- **Task 4 — Browser Streaming Client:** Fetch-based SSE client, parser, sequence tracker, deduplication, gap/replay/snapshot handler, exponential backoff, abort controller.
- **Task 5 — Run Projection & UI Foundation:** Deterministic state projection reducer, `RunHeader`, `StageRail`, `CurrentOperationCard`, connection banner, terminal state.
- **Task 6 — Complete Live Dashboard:** `ActivityTimeline`, `AgentActivityGrid`, `ToolExecutionGroup`, `VerificationPanel`, `EvidenceDrawer`, `RunMetricsBar`, `DecisionTimeline`, `RecoveryBanner`, `ApprovalCard`, `TechnicalEventDrawer`, virtualization.
- **Task 7 — Mobile & Accessibility:** Responsive layout, keyboard focus, ARIA live region (important events only), screen-reader summaries, `prefers-reduced-motion`.
- **Task 8 — Load, Reconnect & Fault Hardening:** Disconnect/reconnect, replay, duplicate delivery, sequence gap recovery, slow-client backpressure, soak testing, memory stability.
- **Task 9 — Final SSE/UI Gate:** Complete test verification, exact SHA verification (`5809fcf1230ff349ff0d7f5b53ed75403f44573b`), self-hosted harness report, unmerged draft PR.

---

## Compatibility, Rollback, and Security Rules

1. **Feature Flag Scoping:** SSE v2 features operate under `FLOWDECK_SSE_V2=true` feature flag during migration.
2. **Schema Versioning:** Event envelope specifies `schemaVersion: 1`. Unsupported versions reject with HTTP 422 / explicit error.
3. **No Private Leakage:** Internal model chain-of-thought, prompt templates, and raw credentials are never broadcast in stream events.
4. **Rollback Safety:** SQLite schema is non-breaking. Disabling SSE v2 flag gracefully falls back to SSE v1 / standard HTTP polling without data loss.

---

## Required Task Performance & Stability Report Template

Every completed subtask must include the following report structure:

```text
Developer: Dev 1
Task: <exact subtask name>
Priority: SSE v2 and live orchestration UI
FlowDeck campaign: <campaign ID>
Frozen FlowDeck harness: v1.0.3

### Task result
- Task name: ...
- Branch: feat/performance-sse-ui-foundation
- Starting SHA: 5809fcf1230ff349ff0d7f5b53ed75403f44573b
- Final SHA: ...
- Files changed: ...
- Implementation summary: ...
- Acceptance criteria: ...
- Readiness score: X/10

### FlowDeck v1.0.3 performance
- Total duration: ...
- Input tokens: ...
- Output tokens: ...
- Tool-call count: ...
- FDX calls: ...

### SSE/UI performance
- Events emitted: ...
- Transport latency: ...
- Render latency: ...
- FPS: ...

### Dual verdict
Task implementation readiness: X/10
FlowDeck v1.0.3 execution quality: X/10
FlowDeck v1.0.3 performance: X/10
FlowDeck v1.0.3 stability: X/10
SSE/UI production readiness: X/10
Merge recommendation: ready | not ready
```
