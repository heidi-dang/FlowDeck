# FlowDeck v2 execution architecture

FlowDeck v2 keeps OpenCode as the model, session, tool, and UI authority. FlowDeck adds a durable decision and execution layer around it.

## Execution path

1. Task intelligence produces a versioned, deterministic routing decision with bounded scores and machine-readable evidence.
2. The decision can be persisted as an execution plan. Plans and workstreams are SQLite-backed, versioned, and reconstructed after restart.
3. Independent ready workstreams are scheduled in deterministic waves. Writing workstreams receive separate Git worktrees and database-backed leases.
4. A controlled integration service validates source ancestry, changed paths, ownership, verification evidence, and dependency order before merging.
5. The existing token-budget controller remains authoritative. Workstream budget handles add reclaim, redistribution, stall observation, and safe termination without creating a second controller.
6. Completed workstreams produce immutable capability-specific performance observations.

The production chat hook defaults to the existing execution behavior. Routing is configured explicitly as `off`, `shadow`, or `enforce`; enforce mode fails closed when its prerequisites are missing and never changes the selected model or provider.

## Persistence and recovery

Execution plans, workstreams, dependency edges, ownership claims, leases, integration attempts, token usage, routing decisions, and performance observations are durable. Startup reconciliation repairs an integration acknowledgement that was persisted before the workstream status update. Lease expiry is explicit and reclaimable; an expired lease is not silently treated as live ownership.

## API projections

The existing orchestration API exposes:

- `GET /api/v1/orchestration/runs/:runId/routing`
- `GET /api/v1/orchestration/agents/:agentId/performance/:capability`
- `GET /api/v1/orchestration/snapshot`

Responses are structured projections. Raw prompts, database paths, and worktree paths are not returned.
