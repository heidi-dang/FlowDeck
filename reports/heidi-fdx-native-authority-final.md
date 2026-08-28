# Final Authoritative Native FDX VCI Authority Acceptance Report (R40)

- **Date:** 2026-08-25T22:22:50.938Z
- **Status:** PASS (10/10)
- **Execution Environment:** linux-x64
- **Harness:** H40 (`scripts/qualify-heidi-fdx-native-authority-final.mjs`)
- **Supersedes:** H39 / R39 (Historical SHA: `ed34f9a4c6ea0938ce97029d773852aae90e241d` / `fe822d5e89cc027bb9891179a1c7b16c5c19ba6e`), H38 / R38, H37 / R37

> **Acceptance Declaration:**
> H39/R39 qualified baseline native functionality, but left a fallback digest synthesis path in M6 plan creation.
> **H40/R40 prove exact, uncompromised native digest provenance across all 34 production and hostile scenarios with zero local digest synthesis remaining.**

---

## 1. Executive Summary & Binary Provenance

- **FDX Native Authority:** FDX is the sole native verification and code-intelligence authority (M1–M12).
- **No Local Digest Synthesis:** FlowDeck no longer reconstructs or manufactures any native authority-bearing plan or policy digest.
- **TypeScript Fallback Isolation:** TypeScript-generated digests exist only in explicitly degraded fallback paths (`digestAuthority: "typescript_fallback"`).
- **M10 Exact Truth:** M10 preserves exact per-check truth without whole-run collapsing.
- **M11 Policy Boundary:** M11 policy overlays require complete native provenance (`policy_snapshot_digest` and `policy_application_digest`).
- **Historical Lineage:** M1–M12 historical lineage remains frozen.

### Binary Provenance Details

| Property | Value |
|---|---|
| Binary Profile | `release` |
| Binary SHA-256 | `e594d5bff0d711890a5bf6ed64210c0fb658b8feb8e9ee9297b0494a9ae1f643` |
| Binary Size | `18198088 bytes` |
| Functional Commit (I13) | `af9482017c05fd68fc1a12a05667d3fb9570bb08` |
| Target Platform | `linux-x64` |

---

## 2. Qualification Scenario Results (34/34 Passed)

| Scenario ID | Title | Status | Duration |
|---|---|---|---|
| S1_EXACT_NATIVE_PROVENANCE | Exact Native Provenance & Functional Commit Binding | PASS | 0ms |
| S2_PROTOCOL_SCHEMA_CONTRACT | Canonical Protocol 2 / Schema 10 / Capability v1 Evaluation | PASS | 5ms |
| S3_SIMPLE_TASK_FAST_BYPASS | Non-Code & Simple Task Fast Classification | PASS | 0ms |
| S4_REAL_CHANGE_INTELLIGENCE | Milestone 1–5 Real Native Change Intelligence | PASS | 9ms |
| S5_NATIVE_PLANNING_M6_EXACT_ORIGIN | Milestone 6 Real Native Verification Planning with Exact Authoritative Digest Passthrough | PASS | 33ms |
| S6_NATIVE_EXECUTION_M7_EXACT_ORIGIN | Milestone 7 Real Native Verification Execution with Exact Digest Origin | PASS | 582ms |
| S7_PERSISTENCE_AND_REOPEN_M8 | Milestone 8 Real Persistence & Exact Artifact Reopen/Query | PASS | 292ms |
| S8_REAL_M8_PERSISTENCE_FAULT | Milestone 8 Real Persistence Fault Injection & Containment | PASS | 26ms |
| S9_PREDICATE_V1_ATTESTATION | Milestone 9 Real Predicate v1 in-toto Attestation Creation & Verification | PASS | 10ms |
| S10_CONTENT_BOUND_STATE_FINGERPRINT | Content-Bound Repository State Fingerprint (Working-Tree Dirty Bytes Binding) | PASS | 7ms |
| S11_M10_PER_CHECK_TRUTH | Milestone 10 Exact Per-Check Truth Preserved Without Whole-Run Collapsing | PASS | 0ms |
| S12_REFUSE_CALIBRATION_ON_INCOMPLETE_EVIDENCE | Milestone 10 Refusal of Calibration Signal on Incomplete Evidence | PASS | 0ms |
| S13_M11_CANDIDATE_GENERATION | Milestone 11 Real Candidate Generation from Qualified M10 Evidence | PASS | 15ms |
| S14_M11_EXPLICIT_PROMOTION | Milestone 11 Real Explicit Candidate Promotion to Active ADD_CHECK Policy | PASS | 12ms |
| S15_M11_ADDITIVE_REPLAN_EXACT_PROVENANCE | Milestone 11 Real Additive Plan Overlay with Exact Native Policy Provenance | PASS | 25ms |
| S16_M11_POLICY_APPLICATION_PERSISTENCE | Milestone 11 Real Policy Application Verification & M8 Persistence | PASS | 30ms |
| S17_PREDICATE_V2_CREATE_AND_VERIFY | Milestone 11 Real Content-Bound in-toto Attestation (Predicate v2) | PASS | 22ms |
| S18_M11_POLICY_REVOCATION | Milestone 11 Real Policy Revocation & Active Set Invalidation | PASS | 14ms |
| S19_HISTORICAL_V2_VERIFIES_AFTER_REVOKE | Milestone 11 Historical Predicate v2 Verification Preserved After Revocation | PASS | 18ms |
| S20_PRODUCTION_VERIFICATION_COMPLETION_PASS | Production VerificationService → FDX Provider → CompletionPolicy Authority Path | PASS | 146ms |
| S21_STALE_EVIDENCE_BLOCKS_COMPLETION | CompletionPolicy Rejection of Stale Verification Evidence | PASS | 0ms |
| S22_PERSISTENCE_FAILURE_BLOCKS_COMPLETION | CompletionPolicy Blocks on M8 Persistence Failure | PASS | 5ms |
| S23_ACTIVE_NATIVE_CANCELLATION | Real Active Cancellation of Native FDX Child Process | PASS | 24ms |
| S24_DURABLE_RESTART_RECOVERY | Durable SQLite Restart & Recovery Loop Convergence | PASS | 45ms |
| S25_REPO_MASTER_FACT_BRIDGE | Real Repo Master Fact Bridge & Architectural Intelligence Invocation | PASS | 0ms |
| S26_OPENCODE_SPECIALIST_DELEGATION | Real OpenCode Native Specialist Child Delegation Registration | PASS | 0ms |
| S27_SINGLE_FLIGHT_DUPLICATE_COALESCING | 20 Duplicate Verification Triggers Coalesce to Single Physical Native Execution | PASS | 300ms |
| S28_CHANGED_STATE_NEW_EXECUTION | Changed Repository State Executes Fresh Verification with Distinct Digest | PASS | 300ms |
| S29_INCOMPATIBLE_CAPABILITIES_FAIL_CLOSED | Incompatible Capability Negotiation Fails Closed Gracefully | PASS | 0ms |
| S30_NATIVE_ABSENCE_FALLBACK | Graceful Fallback Execution When FDX Native Binary is Absent | PASS | 17ms |
| S31_HOSTILE_MISSING_NATIVE_DIGEST_FAIL_CLOSED | Hostile Test 1: Native Plan Missing Authoritative Digest Fails Closed (UNVERIFIED) | PASS | 0ms |
| S32_HOSTILE_NATIVE_DIGEST_WINS_OVER_LOCAL_HASH | Hostile Test 2: Native Authoritative Digest Consumed Over Locally Synthesized JSON Hash | PASS | 0ms |
| S33_HOSTILE_INCOMPLETE_OVERLAY_PROVENANCE_FAIL_CLOSED | Hostile Test 3: Incomplete Policy Overlay Provenance Rejected | PASS | 0ms |
| S34_HOSTILE_TAMPERED_DIGEST_BLOCKS_COMPLETION | Hostile Test 4: Tampered Verification Identity Blocks Completion Policy Transition | PASS | 114ms |

---

## 3. Real Performance Benchmarks (>= 10 Samples)

| Operation | Samples | Min | Median | P95 | Max | Mean |
|---|---|---|---|---|---|---|
| `capabilityNegotiation` | 15 | 3.89ms | 4.07ms | 4.35ms | 4.35ms | 4.06ms |
| `changeIntelligence` | 15 | 8.25ms | 8.58ms | 8.79ms | 8.79ms | 8.55ms |
| `m6Planning` | 15 | 16.08ms | 16.56ms | 16.78ms | 16.78ms | 16.53ms |
| `m7Execution` | 15 | 280.73ms | 291.28ms | 331.2ms | 331.2ms | 295.78ms |
| `attestationV1` | 15 | 4.1ms | 4.27ms | 5.21ms | 5.21ms | 4.36ms |
| `singleFlightCoalescing20x` | 10 | 290.74ms | 290.93ms | 314.05ms | 314.05ms | 293.27ms |

