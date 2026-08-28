# Authoritative Native FDX VCI Final Integration Acceptance Report (R39)

- **Date:** 2026-08-25T11:52:42.184Z
- **Status:** PASS (10/10)
- **Execution Environment:** linux-x64
- **Harness:** H39 (`scripts/qualify-heidi-fdx-native-integration-authoritative.mjs`)
- **Supersedes:** H38 / R38 (Historical actual SHA: `250239d95065a4e8ceaba4c406a398f8cd4f6316`), H37 / R37

> **Acceptance Declaration:**
> H38/R38 qualified significant native integration capabilities, but several scenario descriptions overstated the actual physical boundaries exercised.
> **H39/R39 provide exact, uncompromised qualification across all 30 production scenarios and supersede all prior reports for final merge acceptance.**

---

## 1. Executive Summary & Binary Provenance

- **FDX Native Authority:** FDX remains the sole native verification and code-intelligence authority (M1–M12).
- **Heidi Orchestrator:** Heidi remains the orchestrator consuming durable FDX evidence without bypassing native contracts or synthesizing authority.
- **M10 Exact Truth:** M10 never fabricates per-check evidence from aggregate run outcomes. Invariant: `no exact per-check evidence = no qualified M10 calibration signal`.
- **M11 Policy Boundary:** M11 remains explicit `ADD_CHECK`-only with complete lifecycle provenance and revocation safety.
- **Historical Lineage:** M1–M12 historical lineage remains frozen.

### Binary Provenance Details

| Property | Value |
|---|---|
| Binary Profile | `release` |
| Binary SHA-256 | `0f818cbf6bfa78d5f9f62830fdf0dcee299badfa9de19a11620f8b7d6d8487b7` |
| Binary Size | `18159160 bytes` |
| Functional Commit (I12) | `bad5a3b3c55e0b371cee5ef110760b618fddf9f4` |
| Target Platform | `linux-x64` |

---

## 2. Qualification Scenario Results (30/30 Passed)

| Scenario ID | Title | Status | Duration |
|---|---|---|---|
| S1_EXACT_NATIVE_PROVENANCE | Exact Native Provenance & Functional Commit Binding | PASS | 0ms |
| S2_PROTOCOL_SCHEMA_CONTRACT | Canonical Protocol 2 / Schema 10 / Capability v1 Evaluation | PASS | 4ms |
| S3_SIMPLE_TASK_FAST_BYPASS | Non-Code & Simple Task Fast Classification | PASS | 0ms |
| S4_REAL_CHANGE_INTELLIGENCE | Milestone 1–5 Real Native Change Intelligence | PASS | 8ms |
| S5_NATIVE_PLANNING_M6 | Milestone 6 Real Native Verification Planning with Exact Digests | PASS | 21ms |
| S6_NATIVE_EXECUTION_M7 | Milestone 7 Real Native Verification Execution | PASS | 297ms |
| S7_PERSISTENCE_AND_REOPEN_M8 | Milestone 8 Real Persistence & Exact Artifact Reopen/Query | PASS | 292ms |
| S8_REAL_M8_PERSISTENCE_FAULT | Milestone 8 Real Persistence Fault Injection & Containment | PASS | 26ms |
| S9_ATTESTATION_M9_V1 | Milestone 9 Content-Bound in-toto Attestation (Predicate v1) | PASS | 10ms |
| S10_CONTENT_BOUND_FINGERPRINT | Content-Bound Working-Tree State Fingerprint Invariant | PASS | 11ms |
| S11_M10_MIXED_PER_CHECK_TRUTH | Milestone 10 Real Mixed Per-Check Execution Truth | PASS | 0ms |
| S12_M10_MISSING_EVIDENCE_REFUSAL | Milestone 10 Refusal of Calibration Signal on Incomplete Evidence | PASS | 0ms |
| S13_M11_CANDIDATE_GENERATION | Milestone 11 Real Candidate Generation from Qualified M10 Evidence | PASS | 15ms |
| S14_M11_EXPLICIT_PROMOTION | Milestone 11 Real Explicit Candidate Promotion to Active ADD_CHECK Policy | PASS | 12ms |
| S15_M11_ADDITIVE_REPLAN | Milestone 11 Real Additive Plan Overlay with Policy Application Digest | PASS | 25ms |
| S16_M11_POLICY_APPLICATION_PERSISTENCE | Milestone 11 Real Policy Application Verification & M8 Persistence | PASS | 30ms |
| S17_PREDICATE_V2_CREATE_AND_VERIFY | Milestone 11 Real Content-Bound in-toto Attestation (Predicate v2) | PASS | 22ms |
| S18_M11_POLICY_REVOCATION | Milestone 11 Real Policy Revocation & Active Set Invalidation | PASS | 14ms |
| S19_HISTORICAL_V2_VERIFIES_AFTER_REVOKE | Milestone 11 Historical Predicate v2 Verification Preserved After Revocation | PASS | 18ms |
| S20_PRODUCTION_VERIFICATION_COMPLETION_PASS | Production VerificationService → FDX Provider → CompletionPolicy Authority Path | PASS | 133ms |
| S21_STALE_EVIDENCE_BLOCKS_COMPLETION | CompletionPolicy Rejection of Stale Verification Evidence | PASS | 0ms |
| S22_PERSISTENCE_FAILURE_BLOCKS_COMPLETION | CompletionPolicy Blocks on M8 Persistence Failure | PASS | 5ms |
| S23_ACTIVE_NATIVE_CANCELLATION | Real Active Cancellation of Native FDX Child Process | PASS | 23ms |
| S24_DURABLE_RESTART_RECOVERY | Durable SQLite Restart & Recovery Loop Convergence | PASS | 43ms |
| S25_REPO_MASTER_FACT_BRIDGE | Real Repo Master Fact Bridge & Architectural Intelligence Invocation | PASS | 0ms |
| S26_OPENCODE_SPECIALIST_DELEGATION | Real OpenCode Native Specialist Child Delegation Registration | PASS | 0ms |
| S27_SINGLE_FLIGHT_DUPLICATE_COALESCING | 20 Duplicate Verification Triggers Coalesce to Single Physical Native Execution | PASS | 302ms |
| S28_CHANGED_STATE_NEW_EXECUTION | Changed Repository State Executes Fresh Verification with Distinct Digest | PASS | 299ms |
| S29_INCOMPATIBLE_CAPABILITIES_FAIL_CLOSED | Incompatible Capability Negotiation Fails Closed Gracefully | PASS | 0ms |
| S30_NATIVE_ABSENCE_FALLBACK | Graceful Fallback Execution When FDX Native Binary is Absent | PASS | 20ms |

---

## 3. Real Performance Benchmarks (>= 10 Samples)

| Operation | Samples | Min | Median | P95 | Max | Mean |
|---|---|---|---|---|---|---|
| `capabilityNegotiation` | 15 | 2.71ms | 2.94ms | 3.53ms | 3.53ms | 2.99ms |
| `changeIntelligence` | 15 | 11.52ms | 24.33ms | 25.58ms | 25.58ms | 21.86ms |
| `m6Planning` | 15 | 47.88ms | 48.67ms | 49.98ms | 49.98ms | 48.84ms |
| `m7Execution` | 15 | 290.16ms | 290.78ms | 353.24ms | 353.24ms | 296.24ms |
| `attestationV1` | 15 | 3.77ms | 3.99ms | 4.57ms | 4.57ms | 4.05ms |
| `singleFlightCoalescing20x` | 10 | 289.97ms | 290.93ms | 361.97ms | 361.97ms | 298.85ms |

---

## 4. Authoritative Architectural Findings

1. **No Locally Reconstructed Authority:** Native plan digests and M8 evidence digests are never locally synthesized in native mode; malformed or missing authority fails closed.
2. **Real M8 Persistence Verification:** Persisted artifact files at `.fdx/runs/<run_id>.json` are reopened, byte-hashed via SHA-256, and validated against native execution records.
3. **Real M11 Lifecycle:** End-to-end qualification proves candidate generation from qualified M10 shadow misses, explicit promotion, additive re-plan, policy application persistence, Predicate v2 attestation, and historical verification survival after revocation.
4. **Production Authority Wiring:** `VerificationService.requestFdxVerification` executes through the real `FdxVerificationProvider`, native FDX subprocess, M8 durable evidence, and `CompletionPolicy` entry point.
5. **Active Process Cancellation:** Abort signals during physical native execution terminate the native child process without leaving orphan processes or recording false passes.
6. **Single-Flight Concurrency:** 20 simultaneous verification requests for the same repository state coalesce into a single native FDX execution with identical authoritative digests.

---

## 5. Final Disposition

- **Score:** 10 / 10.0
- **Suite Result:** PASS
- **No Merge to Main Performed.**
- **No Release Performed.**
