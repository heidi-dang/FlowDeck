# Milestone 9: Verification Attestation Qualification Report (R25)

**Milestone:** M9  
**Functional Baseline (F22):** `a3bffac13ba5087c97766ebdcedf21da1e274ebe`  
**Binary SHA-256:** `53b19a74d9e0c281818350100de1a497498350b04676bf47f932c81c0fc3cbb7`  
**Benchmark Harness (H25):** `f37127a656979f0d775ec676d961a5eadc9992f5`  
**Executed At:** 2026-08-24T10:30:26.325Z  
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

- [x] `in_toto_statement_v1_exact_single_subject`: Passed
- [x] `exact_M7_artifact_subject_digest`: Passed
- [x] `qualified_M8_contract_v2_required`: Passed
- [x] `future_M8_contract_rejected`: Passed
- [x] `artifact_digest_mismatch_rejected`: Passed
- [x] `plan_digest_mismatch_rejected`: Passed
- [x] `passed_outcome_preserved`: Passed
- [x] `failed_outcome_preserved`: Passed
- [x] `incomplete_outcome_preserved`: Passed
- [x] `assurance_exactly_preserved`: Passed
- [x] `structured_unresolved_obligations_preserved`: Passed
- [x] `dirty_workspace_cleanliness_not_claimed`: Passed
- [x] `uncertainty_secret_redacted_everywhere`: Passed
- [x] `shared_execution_not_duplicated`: Passed
- [x] `nonphysical_obligation_has_no_physical_execution`: Passed
- [x] `extra_subject_rejected`: Passed
- [x] `unknown_predicate_field_rejected`: Passed
- [x] `noncanonical_attestation_bytes_rejected`: Passed
- [x] `managed_filename_digest_mismatch_rejected`: Passed
- [x] `external_file_without_expected_digest_rejected`: Passed
- [x] `external_file_correct_expected_digest_passes`: Passed
- [x] `external_file_wrong_expected_digest_rejected`: Passed
- [x] `tampered_M7_artifact_detected`: Passed
- [x] `atomic_no_clobber_same_content`: Passed
- [x] `atomic_no_clobber_conflict`: Passed
- [x] `attestation_directory_symlink_escape_rejected`: Passed
- [x] `path_traversal_rejected`: Passed
- [x] `global_history_incomplete_recorded_as_generation_snapshot`: Passed
- [x] `offline_verify_roundtrip`: Passed

## Performance Metrics

| Benchmark Scenario | Samples | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|---|---|---|---|---|---|---|
| Single Run Attest Create | 15 | 4.42 | 4.54 | 5.42 | 5.42 | 4.61 |
| Single Run Attest Verify | 15 | 3.98 | 4.12 | 4.49 | 4.49 | 4.15 |

### Scaling Benchmarks (100 Runs)

- **Attest Create 100 Runs Total:** 454.03 ms (avg 4.54 ms / run)
- **Attest Verify 100 Runs Total:** 805.13 ms (avg 8.05 ms / run)

---
*Qualification completed under FlowDeck Verifiable Change Intelligence protocol.*