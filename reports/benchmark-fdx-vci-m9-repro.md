# Milestone 9: Verification Attestation Qualification Report (R27)

**Milestone:** M9  
**Functional Baseline (F24):** `441d9af2725c051771c8d684c6b26fc560f2e32c`  
**Binary SHA-256:** `1091ee3c78e4e987b887ca79a0b46ef6c697ddbf44fed30c48172c60964438ec`  
**Benchmark Harness (H27):** `9d5ae4b5e862d32ea62bf6385ec305c73074241c`  
**Executed At:** 2026-08-24T11:47:55.102Z  
**Platform:** linux (x64)  
**Node Version:** v24.19.0  
**Predicate Schema Version:** `1`  

## Invariants & Attestation Guarantees

- **in-toto Statement v1 Envelope:** Outer statement follows the standard in-toto Statement v1 specification (`https://in-toto.io/Statement/v1`).
- **Exact Artifact Binding:** Subject binds `sha256` of exact raw persisted M7 `.fdx/runs/<run_id>.json` bytes.
- **Qualified M8 History Required:** Only exact-byte v7/v2 ingested history rows can be attested.
- **RFC 8785 (JCS) Canonicalization:** Canonical byte representation is strictly deterministic across platforms.
- **Fail-Closed Verification:** Any alteration of artifact, subject, predicate, checks, executions, or generator metadata causes verification failure.
- **Handle-Based Filesystem & Symlink Safety:** Strict directory jail verification holding safe open handles. Managed operations execute relative to opened directory descriptors (`openat`, `linkat`, `NOFOLLOW`), defeating TOCTOU substitution.
- **Atomic No-Clobber Publication:** Full bytes flushed to unique temp handle and linked atomically; never writes partially to final content-addressed paths.
- **Bounded Readers:** Strictly limits memory allocation and buffer reads to at most 16 MiB + 1 byte.
- **Secret and Excerpt Exclusion:** Free-text execution excerpts and secrets are excluded from attestation statements.
- **Unsigned Local Evidence:** Attestation provides cryptographic content binding locally without false signer claims.

## Semantic Preflight Verification

- [x] `in_toto_statement_v1_exact_single_subject`: Passed
- [x] `exact_M7_artifact_subject_digest`: Passed
- [x] `qualified_M8_contract_v2_required`: Passed
- [x] `future_M8_contract_rejected`: Passed
- [x] `predicate_runtime_contract_v3_rejected`: Passed
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
- [x] `external_content_address_lookalike_requires_expected_sha`: Passed
- [x] `external_content_address_lookalike_correct_sha_passes`: Passed
- [x] `fdx_parent_symlink_escape_rejected`: Passed
- [x] `attestations_dir_symlink_escape_rejected`: Passed
- [x] `managed_attestation_file_symlink_rejected`: Passed
- [x] `oversized_attestation_rejected`: Passed
- [x] `non_regular_attestation_rejected`: Passed
- [x] `atomic_publication_conflict_no_overwrite`: Passed
- [x] `atomic_publication_same_content_race`: Passed
- [x] `atomic_publication_unsupported_has_no_final_file`: Passed
- [x] `target_symlink_race_rejected`: Passed
- [x] `target_identical_byte_symlink_race_rejected`: Passed
- [x] `managed_directory_swap_cannot_escape`: Passed
- [x] `external_file_swap_does_not_bypass_anchor`: Passed
- [x] `bounded_read_growth_rejected`: Passed
- [x] `huge_existing_target_bounded`: Passed
- [x] `broken_managed_jail_never_downgrades_to_external`: Passed
- [x] `predicate_runtime_contract_v1_rejected`: Passed
- [x] `predicate_run_qualified_false_rejected`: Passed
- [x] `generator_name_tamper_rejected`: Passed

## Performance Metrics

| Benchmark Scenario | Samples | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|---|---|---|---|---|---|---|
| Single Run Attest Create | 15 | 5.39 | 5.66 | 20.14 | 20.14 | 6.81 |
| Single Run Attest Verify | 15 | 4.92 | 5.48 | 5.99 | 5.99 | 5.41 |

### Scaling Benchmarks (100 Runs)

- **Attest Create 100 Runs Total:** 536.61 ms (avg 5.37 ms / run)
- **Attest Verify 100 Runs Total:** 540.78 ms (avg 5.41 ms / run)

---
*Qualification completed under FlowDeck Verifiable Change Intelligence protocol.*