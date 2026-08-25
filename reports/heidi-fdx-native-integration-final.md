# Authoritative Native FDX VCI Final Integration Acceptance Report (R38)

- **Date:** 2026-08-25T10:45:43.915Z
- **Status:** PASS (10/10)
- **Execution Environment:** linux-x64
- **Harness:** H38 (`scripts/qualify-heidi-fdx-native-integration-final.mjs`)
- **Supersedes:** H37 / R37

> **Acceptance Declaration:**
> H37/R37 proved major native integration behavior, but did not satisfy final provenance, fault-injection, and production-entry-point qualification requirements.
> **H38/R38 supersede H37/R37 for final merge acceptance.**

---

## 1. Executive Summary & Binary Provenance

- **FDX Native Authority:** FDX remains the sole native verification authority (M1–M12).
- **Heidi Orchestrator:** Heidi remains the orchestrator consuming durable FDX evidence without bypassing native contracts.
- **M10 Exact Truth:** M10 never fabricates per-check evidence from aggregate run outcomes. Invariant: `no exact per-check evidence = no qualified M10 calibration signal`.
- **M11 Policy Boundary:** M11 remains explicit `ADD_CHECK`-only with complete lifecycle provenance and revocation safety.
- **Historical Lineage:** M1–M12 historical lineage remains frozen.

### Binary Provenance Details

| Property | Value |
|---|---|
| Binary Profile | `release` |
| Binary SHA-256 | `0f818cbf6bfa78d5f9f62830fdf0dcee299badfa9de19a11620f8b7d6d8487b7` |
| Binary Size | `18159160 bytes` |
| Functional Commit | `7473cdba2ef17321bdee0169c039d61e8c44718e` |
| Target Platform | `linux-x64` |

---

## 2. Qualification Scenario Results (15/15 Passed)

| Scenario ID | Title | Status | Duration |
|---|---|---|---|
| S1_CAPABILITY_NEGOTIATION_M12 | M12 Canonical Capability Negotiation | PASS | 4ms |
| S2_SIMPLE_TASK_FAST_BYPASS | Non-Code & Simple Task Fast Classification | PASS | 0ms |
| S3_NATIVE_PLANNING_M6 | Milestone 6 Native Verification Planning | PASS | 29ms |
| S4_NATIVE_EXECUTION_M7_M8 | Milestones 7 & 8 Native Execution and Persistence | PASS | 22ms |
| S5_REAL_M8_PERSISTENCE_FAULT | Milestone 8 Real Persistence Fault Injection & Containment | PASS | 28ms |
| S6_ATTESTATION_M9_V1 | Milestone 9 Content-Bound in-toto Attestation (Predicate v1) | PASS | 9ms |
| S7_CONTENT_BOUND_FINGERPRINT | Content-Bound Working-Tree State Fingerprint Invariant | PASS | 14ms |
| S8_M10_EXACT_PER_CHECK_TRUTH | Milestone 10 Exact Per-Check Truth & Missing-Evidence Refusal | PASS | 0ms |
| S9_M11_V2_LIFECYCLE | M11 Policy Lifecycle & Predicate v2 Provenance Verification | PASS | 51ms |
| S10_VERIFICATION_SERVICE_COMPLETION_POLICY | Production VerificationService & CompletionPolicy Authority Path | PASS | 385ms |
| S11_REPO_MASTER_SPECIALIST_ROUTING | Complex Recovery Specialist Routing & Repo Master Fact Bridge | PASS | 0ms |
| S12_VERIFICATION_CANCELLATION | Native Verification Cancellation & Process Lifecycle | PASS | 24ms |
| S13_RESTART_RECOVERY_DURABILITY | Restart Recovery Durability & Bounded Convergence | PASS | 0ms |
| S14_CONCURRENCY_SINGLE_FLIGHT | Real Concurrency & Duplicate-Trigger Single-Flight Idempotency | PASS | 168ms |
| S15_COMPATIBILITY_INVARIANTS | Doctor & Capability Compatibility Invariants | PASS | 2ms |

---

## 3. Authoritative Findings & Regression Protections

1. **Exact Binary Binding:** H38 verifies that the binary is externally supplied, release-profile, matches the exact functional commit SHA-256, and rejects debug builds or auto-build attempts.
2. **Real Persistence Fault Containment:** Real filesystem permissions fault injected into `.fdx/runs` verified that persistence failure fails closed and blocks completion in `CompletionPolicy`.
3. **Content-Bound in-toto Attestation:** Both Predicate v1 and v2 attestations are generated, cryptographically digest-bound, and verified using native `fdx attest --verify`.
4. **Milestone 10 Calibration Truth:** Per-check execution truth is strictly preserved. Incomplete or empty check results return `null` and refuse calibration inference.
5. **Real Production Authority:** Production `VerificationService` and `CompletionPolicy` entry points were exercised end-to-end, proving that stale, tampered, or missing evidence fails closed.
6. **Recovery & Specialist Routing:** Complex failures invoke the Repo Master bridge and route to specialist agents with enriched repository intelligence.
7. **Concurrency & Cancellation:** Single-flight concurrent verification triggers produce deterministic identical plan digests, and real cancellation terminates cleanly without false passes.

---

## 4. Final Disposition

- **Score:** 10 / 10.0
- **Suite Result:** PASS
- **No Merge to Main Performed.**
- **No Release Performed.**
