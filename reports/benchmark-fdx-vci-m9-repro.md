# Milestone 9: Verification Attestation Qualification Report (R26)

**Milestone:** M9  
**Functional Baseline (F23):** `423cf0bbeebc3cfe1db994dca49d30b64794c246`  
**Binary SHA-256:** `e3792c6e3a38579e274813829177b87a6e54894d289682bf49ef51832e548ba9`  
**Benchmark Harness (H26):** `482f8e44ee98884e689ca42d439c90e773998f95`  
**Executed At:** 2026-08-24T11:23:06.003Z  
**Platform:** linux (x64)  
**Node Version:** v24.19.0  
**Predicate Schema Version:** `1`  

## Invariants & Attestation Guarantees

- **in-toto Statement v1 Envelope:** Outer statement follows the standard in-toto Statement v1 specification (`https://in-toto.io/Statement/v1`).
- **Exact Artifact Binding:** Subject binds `sha256` of exact raw persisted M7 `.fdx/runs/<run_id>.json` bytes.
- **Qualified M8 History Required:** Only exact-byte v7/v2 ingested history rows can be attested.
- **RFC 8785 (JCS) Canonicalization:** Canonical byte representation is strictly deterministic across platforms.
- **Fail-Closed Verification:** Any alteration of artifact, subject, predicate, checks, executions, or generator metadata causes verification failure.
- **Managed Path & Symlink Safety:** Strict directory jail verification for `.fdx` and `.fdx/attestations`. Managed filenames valid only inside canonical managed parent.
- **Atomic No-Clobber Publication:** Full bytes flushed to temp and promoted atomically; never writes partially to final content-addressed paths.
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
- [x] `external_content_address_lookalike_requires_expected_sha`: Passed
- [x] `external_content_address_lookalike_correct_sha_passes`: Passed
- [x] `fdx_parent_symlink_escape_rejected`: Passed
- [x] `attestations_dir_symlink_escape_rejected`: Passed
- [x] `managed_attestation_file_symlink_rejected`: Passed
- [x] `oversized_attestation_rejected`: Passed
- [x] `non_regular_attestation_rejected`: Passed
- [x] `atomic_publication_conflict_no_overwrite`: Passed
- [x] `predicate_runtime_contract_v1_rejected`: Passed
- [x] `predicate_run_qualified_false_rejected`: Passed
- [x] `generator_name_tamper_rejected`: Passed

## Performance Metrics

| Benchmark Scenario | Samples | Min (ms) | Median (ms) | P95 (ms) | Max (ms) | Mean (ms) |
|---|---|---|---|---|---|---|
| Single Run Attest Create | 15 | 5.38 | 5.63 | 6.15 | 6.15 | 5.68 |
| Single Run Attest Verify | 15 | 4.55 | 5.06 | 5.76 | 5.76 | 5.1 |

### Scaling Benchmarks (100 Runs)

- **Attest Create 100 Runs Total:** 547.38 ms (avg 5.47 ms / run)
- **Attest Verify 100 Runs Total:** 524.57 ms (avg 5.25 ms / run)

---
*Qualification completed under FlowDeck Verifiable Change Intelligence protocol.*