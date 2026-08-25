# Heidi Orchestrator Maturity + Dynamic Specialist Runtime — Source-Bound Qualification

**Status:** Qualified source candidate. This document records the evidence for the functional source commit only; an independent remote gatekeeper verdict follows in a separate report-only commit.

| Provenance item | Value |
|---|---|
| Starting report/delivery HEAD | `ae313b9c85e5a1879a5308bbd31b8c7725a3e735` |
| Prior qualified functional SHA | `a39a39b86178e0ca54d22644436894e1c8a6574d` |
| Qualified functional SHA | `767c71b8c7e0563b076a76858a09369ab82b5140` |
| Functional commit | `feat(orchestration): add adaptive specialist runtime` |
| Qualification time (UTC) | `2026-08-25T00:38:16Z` |
| Source state before and after qualification | Clean |

> **Boundary:** This stage adds adaptive orchestration semantics on the existing FlowDeck and OpenCode-native execution foundations. It does not create Repo Master, a second scheduler, a second agent runtime, a custom subagent engine, specialist-specific model routing, or a completion bypass.

## Qualified behavior

| Area | Evidence-backed result |
|---|---|
| **DIRECT** | Deterministic fast-direct routing produces no SpecialistSpec and creates no native child registration. Long but simple and query-style work remains direct. |
| **SINGLE_SPECIALIST** | A persisted plan produces exactly one bounded native Task intent, and native registration durably records its specialist identity. |
| **MULTI_SPECIALIST** | Independent ready specs are batched through the existing bounded parent-session dispatch channel; duplicate idle events do not emit a second team. |
| **Dependency ordering** | Deep migration plans encode `architecture-architect → review-reviewer`; the dependent review is not dispatched until the prerequisite native Task completes. |
| **Restart safety** | Routing evidence contains the serialized plan. A rehydrated runtime reads that contract and does not duplicate a previously dispatched team. |
| **Fan-out and recursion** | Candidate scopes are deduplicated, the configurable planner cap is enforced, dependency cycles/missing dependencies fail closed, and specialist-originated recursive delegation is denied. |
| **Model and tool authority** | Every spec uses `modelPolicy: inherit`; supplied model values are ignored. Allowed tools are copied from canonical native-subagent metadata, while forged capabilities fail persisted-plan validation. |
| **Diagnostics and progress** | Existing snapshots and public read-only session diagnostics expose execution mode plus compact planned/active/blocked/completed/failed/attempt counters. Prompts and models are not projected. |
| **Terminal authority** | Specialist prose and child settlement do not complete a Run. Existing VerificationService and CompletionPolicy gates remain authoritative. |

## Performance evidence

The benchmark uses 500 measured deterministic in-process iterations after 50 warm-up operations. It deliberately measures FlowDeck classification and SpecialistSpec construction—not model or OpenCode network latency—so it detects orchestration overhead without weakening runtime correctness.

| Measurement | p95 result | Budget | Result |
|---|---:|---:|---|
| DIRECT routing | 0.008888 ms | 5 ms | PASS |
| SINGLE_SPECIALIST setup | 0.027419 ms | 10 ms | PASS |
| MULTI_SPECIALIST setup | 0.039384 ms | 10 ms | PASS |

The source-bound machine-readable artifact is [`qualification-adaptive-specialists-767c71b8.json`](qualification-adaptive-specialists-767c71b8.json).

## Gates completed on the functional SHA

| Gate | Result |
|---|---|
| Focused routing, specialist, production lifecycle, observability suite | PASS — 191 tests, 0 failures |
| Full repository test suite | PASS — 2,896 tests passed, 2 declared daemon-injection skips, 0 failures |
| Coverage | PASS — 84.56%, exceeding 80% requirement |
| Lint and strict TypeScript check | PASS |
| Doctor repair end-to-end | PASS — 3 tests |
| Generated and live schema validation | PASS |
| Normal `node scripts/pre-push.mjs --full` | PASS |
| Isolated `[color] ui = always` `node scripts/pre-push.mjs --full` | PASS |
| Native FDX format, Clippy, full test suite, and TS/Rust parity | PASS |
| Native FDX forced-colour parsed-diff regression | PASS |
| Frozen V1–V14 migration manifest and migration diff | PASS |
| Working tree after qualification | Clean |

## Scope integrity

The functional change is confined to execution-mode classification, persisted SpecialistSpec planning, native Task lifecycle metadata, diagnostics, bounded metrics, benchmark support, and production-path tests. No migration changed, and no CompletionPolicy, VerificationService, replacement, continuation, or convergence source was modified. Existing authority suites were re-run as regression evidence.

## Next boundary

The functional source is frozen at `767c71b8c7e0563b076a76858a09369ab82b5140`. Only evidence/report commits may follow. The next required action is an independently cloned, adversarial gatekeeper review of the pushed exact source; **Repo Master must not begin**.
