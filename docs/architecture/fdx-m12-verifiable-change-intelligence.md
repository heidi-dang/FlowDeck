# FDX M12: Verifiable Change Intelligence Final Consolidation

## Status and Scope

**Milestone 12 (M12)** consolidates FlowDeck Verifiable Change Intelligence (VCI) without changing the frozen responsibilities of earlier milestones. It introduces a policy-aware **Predicate v2** attestation and a deterministic, local-only capability contract. M12 is not a learning, selection, or calibration algorithm. It binds already persisted M11 `ADD_CHECK` policy authority to an M7 verification run when such authority actually widened that run.

| Contract | M12 value | Compatibility rule |
|---|---:|---|
| in-toto envelope | Statement v1 | Retained unchanged for v1 and v2 predicates |
| v1 predicate URI | `https://flowdeck.dev/attestation/vci/verification/v1` | Frozen, strict, and byte-compatible |
| v2 predicate URI | `https://flowdeck.dev/attestation/vci/verification/v2` | Additive; selected only when requested |
| Predicate v1 schema | `1` | Default for `fdx attest create` |
| Predicate v2 schema | `2` | Binds historical M11 application provenance |
| Protocol | `2` | Existing negotiation fields remain available |
| Graph schema | `10` | No M12 database migration; v1–v10 migrations remain immutable |
| Capability contract | `1` | Local, deterministic, machine-readable, and version-gated |

> **Authority boundary.** M12 verifies persisted evidence. It does not promote candidates, generate policies, remove M6 checks, upgrade assurance, remove unresolved obligations, or permit policy-derived observations to self-reinforce M10/M11 eligibility.

## Predicate v2 Policy Provenance

Predicate v2 uses the same in-toto Statement v1 envelope as Predicate v1. Its shared run, plan, result, execution, check, uncertainty, runtime-history, source-context, and generator projection is built through the frozen v1 builder. The only M12-specific field is an optional `policy_context`.

| `policy_context` behavior | Requirement |
|---|---|
| Base-only M7 run | The field is absent. No synthetic application ID, policy ID, or snapshot is emitted. |
| Overlay-widened M7 run | The field is present only after exact reconstruction of an M11 policy application. |
| Missing application | Predicate v2 creation fails closed. |
| Tampered application, snapshot, policy, template, or additions | Predicate v2 verification fails closed. |
| Later policy revocation | A historical attestation remains verifiable if its policy was promoted at application time and the historical evidence still reproduces exactly. |

The context content-binds the base-plan and effective-plan digests; policy-snapshot and policy-application digests; canonical `added_check_ids`; every applied policy ID, policy digest, template digest, and action; and the M11 policy contract version. The implementation retains the raw SQLite `added_check_ids_json` text and independently compares it with canonical RFC 8785 serialization of the parsed IDs. It also recomputes the frozen M11 application digest using its original pre-derived-ID input shape. These checks prevent a valid application identifier from being attached to an altered list of policy additions.

### Historical reconstruction and revocation

Predicate v2 reconstructs policy authority as of the persisted application timestamp. A policy later marked `revoked` is normalized back to its historical promoted lifecycle only for that prior timestamp; current active-policy state is not used to rewrite the attested past. The reconstructed snapshot, persisted templates, impacted scopes, M6 base plan, additive overlay, effective plan, and recorded application must all agree exactly.

This design deliberately fails closed when exact reproduction is unavailable. Examples include a missing run artifact, a changed or corrupt template, a snapshot digest mismatch, a non-additive effective plan, multiple applications for one effective plan digest, or discovery that no longer reproduces the stored M6 base plan. A v2 statement remains unsigned and content-bound; it does not imply a signing identity or a network trust service.

## Strict Mixed-Version Persistence and Loading

Attestation persistence remains content-addressed and atomic. The established Predicate v1 persistence API is retained. Predicate v2 uses the same managed-directory jail and atomic publication mechanism, but its document is serialized independently and therefore cannot alter v1 bytes.

The version-dispatched loader performs one authenticated file read, validates the managed filename or external expected SHA-256 anchor, and only then classifies `predicateType`. It accepts exactly the two supported URIs and strictly deserializes the matching v1 or v2 structure with unknown fields rejected. Unknown URIs, including a future v3 URI, are rejected rather than coerced to v1. The legacy v1 loader remains available and rejects v2 documents rather than weakening its historical contract.

| CLI operation | M12 behavior |
|---|---|
| `fdx attest create --run <id>` | Preserves Predicate v1 as the default. |
| `fdx attest create --run <id> --predicate-version v2` | Creates a v2 statement only after policy-context reconstruction succeeds. |
| `fdx attest verify <file>` | Authenticates, detects v1 or v2 by URI, and dispatches to the strict matching verifier. |
| `fdx attest show <file>` | Authenticates and displays either predicate; v2 text includes whether policy context is present. |
| `fdx attest list` | Lists authenticated v1 and v2 artifacts with an explicit predicate type. |

## Local Deterministic Capabilities

`fdx capabilities --format json` emits capability-contract version `1`. It does not open a repository database, contact a network endpoint, perform update checks, or emit telemetry. A caller can request a specific contract version through `--contract-version`; unsupported versions are rejected before the output can be used as compatibility authority.

The document reports protocol and graph-schema authority; read, write, and verify semantics; supported predicate versions (`v1`, `v2`); M10 calibration contract version `2`; M11 policy contract version `1`; assurance-level names; local SCIP and Tree-sitter state; native local-process execution state; operating-system limitations; and explicit `network_access: false` and `telemetry: false` values.

The daemon negotiation response remains backward-compatible: its legacy `attestation_predicate_version: 1` field is retained, while the capability-contract version and supported predicate/calibration/policy version lists are additive. The TypeScript/native contract test verifies this parity. A database newer than the advertised maximum writable schema must not be written by this binary; normal database opening continues to reject unsupported future schemas before mutation.

## M12 Qualification Boundaries

M12 qualification exercises the full persisted-evidence path rather than only data-structure assertions. The focused test set covers v1 projection stability, v2 base-only statements, strict unknown-field and future-URI rejection, deterministic canonical output after SQLite reopen, local capability CLI output, native negotiation parity, actual M11 overlay application binding, persisted qualified M10 template provenance, tampered application context rejection, persisted `added_check_ids_json` corruption rejection, and a later policy revocation followed by successful historical v2 verification.

The execution evidence is Linux-specific unless a report explicitly records another platform. Capability output describes platform limitations rather than claiming cross-platform runtime qualification. M12 does not transmit code, run artifacts, calibration records, policy records, or attestations; privacy and offline behavior are bounded by the local binary, local filesystem, and embedded SQLite evidence store.

## Operational Invariants

1. Predicate v1 remains strict and byte-compatible; v2 is additive and never silently substituted.
2. M6 remains independently callable and is reconstructed before any M11 overlay comparison.
3. M11 remains `ADD_CHECK` only. Base checks, assurance, and unresolved obligations must remain unchanged.
4. M10 remains measurement-only and policy candidate evidence excludes `candidate_selected = 1`.
5. A v2 policy context is absent for base-only runs and mandatory for runs containing learned-policy checks.
6. Missing, ambiguous, non-canonical, tampered, corrupt, or historically unreproducible policy evidence fails closed.
7. Capability reporting is deterministic and local; it has no network or telemetry side effect.
8. M12 introduces no schema v11 migration and does not modify historical migrations v1–v10.

## References

[1] [Predicate v2 implementation](../../crates/fdx/src/intelligence/attestation/v2.rs)

[2] [Strict attestation persistence and dispatch](../../crates/fdx/src/intelligence/attestation/persist.rs)

[3] [M12 local capability contract](../../crates/fdx/src/intelligence/capabilities.rs)

[4] [M11 additive overlay implementation](../../crates/fdx/src/intelligence/policy/overlay.rs)

[5] [M12 focused regression tests](../../crates/fdx/tests/test_attestation_v2_policy_binding.rs)
