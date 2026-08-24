# Milestone 9: Verification Attestation Qualification Report (R24)

**Milestone:** M9  
**Functional Baseline (F21):** `11a3387d6cd9ffa4bef0bc7813e6886def763b71`  
**Binary SHA-256:** `4d21cd694bc64ff2e098be34c4261415dcd994c73add4ee2f9093b8e0c5820e2`  
**Benchmark Harness (H24):** `e1834b4665d18bacc6526d0db2bb451e44b93057`  
**Executed At:** 2026-08-24T09:29:51.324Z  
**Platform:** linux (x64)  
**Node Version:** v24.19.0  
**Predicate Schema Version:** `1`  

## Invariants & Attestation Guarantees

- **in-toto Statement v1 Envelope:** Outer statement follows the standard in-toto Statement v1 specification (`https://in-toto.io/Statement/v1`).
- **Exact Artifact Binding:** Subject binds `sha256` of exact raw persisted M7 `.fdx/runs/<run_id>.json` bytes.
- **Qualified M8 History Required:** Only exact-byte v7/v2 ingested history rows can be attested.
- **RFC 8785 (JCS) Canonicalization:** Canonical byte representation is strictly deterministic across platforms.
- **Fail-Closed Verification:** Any alteration of artifact, subject, predicate, checks, or executions causes verification failure.
- **Secret and Excerpt Exclusion:** Free-text execution excerpts and secrets are excluded from attestation statements.
- **Unsigned Local Evidence:** Attestation provides cryptographic content binding locally without false signer claims.

## Semantic Preflight Verification

- [x] `in_toto_statement_v1_shape`: Passed
- [x] `exact_M7_artifact_subject_digest`: Passed
- [x] `qualified_M8_contract_required`: Passed
- [x] `legacy_M8_contract_rejected`: Passed
- [x] `artifact_digest_mismatch_rejected`: Passed
- [x] `plan_digest_mismatch_rejected`: Passed
- [x] `passed_outcome_preserved`: Passed
- [x] `failed_outcome_preserved`: Passed
- [x] `incomplete_outcome_preserved`: Passed
- [x] `assurance_never_upgraded`: Passed
- [x] `unresolved_obligations_preserved`: Passed
- [x] `shared_execution_not_duplicated`: Passed
- [x] `nonphysical_obligation_has_no_physical_execution`: Passed
- [x] `M7_M8_check_mismatch_rejected`: Passed
- [x] `deterministic_canonical_bytes`: Passed
- [x] `deterministic_attestation_sha256`: Passed
- [x] `tampered_run_artifact_detected`: Passed
- [x] `tampered_attestation_subject_detected`: Passed
- [x] `tampered_attestation_predicate_detected`: Passed
- [x] `unknown_statement_type_rejected`: Passed
- [x] `unknown_predicate_type_rejected`: Passed
- [x] `unknown_predicate_version_rejected`: Passed
- [x] `malformed_attestation_rejected`: Passed
- [x] `secret_excerpts_not_serialized`: Passed
- [x] `absolute_repo_path_not_serialized`: Passed
- [x] `dirty_workspace_does_not_claim_source_snapshot_subject`: Passed
- [x] `atomic_attestation_persistence`: Passed
- [x] `same_attestation_idempotent`: Passed
- [x] `contradictory_existing_attestation_rejected`: Passed
- [x] `attestation_path_traversal_rejected`: Passed
- [x] `global_history_incomplete_recorded_without_false_failure`: Passed
- [x] `offline_verify_roundtrip`: Passed

## Performance Metrics

| Benchmark Scenario | Samples | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|---|---|---|---|---|---|---|
| Single Run Attest Create | 15 | 4.75 | 4.93 | 5.55 | 5.55 | 5.06 |
| Single Run Attest Verify | 15 | 3.27 | 3.65 | 5.23 | 5.23 | 3.75 |

### Scaling Benchmarks (100 Runs)

- **Attest Create 100 Runs Total:** 473.07 ms (avg 4.73 ms / run)
- **Attest Verify 100 Runs Total:** 354.17 ms (avg 3.54 ms / run)

---
*Qualification completed under FlowDeck Verifiable Change Intelligence protocol.*