# FlowDeck Next-Gen Architecture v0.2.6

## 1. Overview
FlowDeck v0.2.6 introduces a durable, SQLite-backed event/outbox orchestration engine with deterministic routing, FDX IPC daemons for fast native execution, and a live SSE v2 UI dashboard.

## 2. Core Components

### 2.1 Durable Orchestration Runtime
- **SQLite State Store**: Atomic state transitions with optimistic versioned locking.
- **Event Store & Outbox**: Append-only event streams. Deliveries to external subscribers occur via the transactional outbox to guarantee at-least-once delivery.
- **Replay & Recovery**: The entire system can cleanly reconstruct state across process restarts.

### 2.2 FDX Native Stack
- **Daemon IPC**: A versioned local daemon providing rapid AST-aware parsing, batching, and cache hits without startup overhead. Windows uses Named Pipes, Unix uses Domain Sockets.
- **Index & Cache**: Content-bound, repository-boundary validation with persistent indexing.
- **Trusted Native Execution**: Bound to exact checksums and provenance.

### 2.3 UI & SSE v2
- **Live Orchestration Dashboard**: Rendered via SSE v2 streams with monotonic ordering guarantees, replay capabilities, and backpressure handling.

### 2.4 Routing & Scheduling
- **Deterministic Routing**: Task categorization into capability tiers with model switching and fallback capabilities.
- **Bounded Concurrency**: Specialist agents (mapper, architect, coder, reviewer) execute safely within context budget bounds.

## 3. Strict Schema Bound
This document is strictly bound to `schema-v0.2.6.sql`. Any modifications to the schema or this document require a formal version bump and CI freeze update.
