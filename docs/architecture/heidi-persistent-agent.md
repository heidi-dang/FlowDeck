# Heidi persistent-agent layer

OpenCode remains responsible for model access, the primary interactive session, and the general tool host. FlowDeck owns the durable, governed intelligence layer on top of that runtime.

```text
HEIDI
├── Persistent brain
│   ├── user / agent memory (versioned SQLite records)
│   ├── repo memory (.codebase/MEMORY.json, unchanged scope)
│   ├── session archive + FTS5 recall
│   ├── evidence-backed learning candidates
│   └── versioned learned skills
└── Execution brain
    ├── durable orchestration and evidence
    ├── bounded delegation
    ├── FDX and Better Harness
    ├── governed tool pipelines
    └── durable scheduler leases
```

Memory writes are transactional, scoped, versioned, provenance-bearing, and scanned for secrets or governance-bypass instructions. Automatic learning defaults to review mode. Core bundled skills are not mutated by the curator. Session recall is a searchable archive, not authoritative orchestration state.

The v2 migration adds memory/version records, session messages and FTS5 indexes, learning candidates/events, learned skill versions, and scheduler job/run records. Scheduled claims use a transaction and lease; unknown externally-effectful work is not automatically replayed.
