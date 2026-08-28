# FDX M11: Qualified Learned Verification-Policy Overlay (D32)

**Status:** Implemented and qualification-gated at F31 `d8f6c1ff4f1cfb34fe47661cba4b07aa934d8568`.

M11 is a deliberately narrow, auditable overlay on the frozen M6 verification planner. It consumes only **qualified M10 observed-shadow-miss evidence** to propose and explicitly promote an `ADD_CHECK` policy. It is not a replacement planner, an assurance optimizer, or a calibration feedback loop.

> **Authority boundary.** M11 may add one exact persisted check when a promoted scope trigger is impacted. It must never remove, suppress, skip, downgrade, or replace an M6 check; change assurance; or remove an unresolved obligation.

## Operating Model

| Stage | Authority | Required evidence or input | Output | Fail-closed boundary |
|---|---|---|---|---|
| Candidate generation | Descriptive only | Current-contract M10, complete, non-truncated calibration rows; qualified physical observed-shadow-miss rows with `candidate_selected = 0` | `policy_candidates` and deduplicated evidence references | Ineligible, incomplete, null-artifact, or policy-selected evidence is excluded |
| Explicit promotion | Additive authority only | Eligible candidate, current thresholds, deterministic qualified source provenance, complete current discovery | One `promoted_policies` row linked to an exact template | `IMMEDIATE` transaction revalidates candidate, source, cap, and digests |
| Planning overlay | Additive plan mutation only | Frozen M6 base plan, active policy snapshot, persisted exact template, affected scope | `EffectiveVerificationPlan` | Missing/corrupt template, provenance, identity, action, state, or scope mismatches stop the overlay |
| Verification audit | Audit only | Effective plan and active snapshot | Content-addressed policy application record before M7 execution | `--no-persist` suppresses both application and verification-run persistence |
| Revocation | Authority removal only | Explicit policy id and redacted reason | Future snapshots omit policy | Candidate evidence, events, templates, and existing applications remain retained |

## Qualification Boundary

Candidate evidence is valid only if all of the following remain true at generation and promotion time:

1. The calibration run uses M10 calibration contract v2, is `complete`, has no truncated reference set, and has non-null source artifact and record digests.
2. Its metrics have no incomplete shadow executions and are eligible for miss-rate computation.
3. The referenced check was **not** candidate-selected, **was** reference-selected, had physical execution, failed, and is classified as an `observed_shadow_miss`.
4. Support is counted as distinct calibration, source-artifact, and candidate-plan identities. M11 does not use policy-added plan selections as new support.
5. The candidate continues to meet its exact promotion configuration digest, support thresholds, runtime bound, and active-policy cap.

The calibration subsystem remains measurement-only. M11 does not write policy authority into M10 calibration logic, does not modify M10 reports, and does not alter M6/M7/M8/M9 behavior when the overlay option is absent.

## Exact Template Binding and Provenance

Promotion performs safe current test/check discovery once. It accepts only a check that exactly matches the qualified candidate `check_id` and scope, then constructs a policy-widening `PlannedCheck` with structural strength and `widening_reason = learned_policy_add_check`. The canonical serialized check is stored in `policy_check_templates` with a SHA-256 template digest and deterministic source calibration/artifact/record provenance.

The promoted policy identity and digest include that template digest. Active-policy snapshots reject nullable, empty, unknown, unsupported, or digest-inconsistent fields. Overlay planning loads the persisted template by digest; it **never rediscovers a substitute template**. The historical migration leaves `template_digest` nullable to preserve additive database compatibility, but runtime treats a null value as corrupt and refuses all overlay authority.

| Persisted record | Binding and audit role |
|---|---|
| `policy_candidate_evidence` | Stable qualified M10 input identity; source rows are non-policy-selected only |
| `policy_check_templates` | Canonical exact `PlannedCheck`, template digest, and source calibration/artifact/record provenance |
| `promoted_policies` | Candidate, `ADD_CHECK` action, scope trigger, template digest, and template-bound policy digest |
| `policy_events` | Immutable promotion and revocation events |
| `policy_applications` | Content-addressed base-plan, snapshot, effective-plan, and added-check audit record |

## CLI Semantics

```text
fdx policy generate-candidates --format json
fdx policy list-candidates --format json
fdx policy show-candidate <candidate-id> --format json
fdx policy promote-candidate <candidate-id> --format json
fdx policy list-active --format json
fdx policy revoke-policy <policy-id> --reason <redacted-reason> --format json

fdx plan --policy-overlay --base <base> --head <head> --format json
fdx verify --policy-overlay --base <base> --head <head> --format json
fdx verify --policy-overlay --no-persist --base <base> --head <head> --format json
```

The default commands, `fdx plan` and `fdx verify`, call frozen M6/M7 paths unchanged. `fdx plan --policy-overlay` opens the evidence database read-only and returns a deterministic effective-plan wrapper; planning has no persistence authority. `fdx verify --policy-overlay` persists a policy application before frozen M7 execution unless `--no-persist` is supplied.

## Rejection and Revocation Semantics

A promotion fails rather than weakening verification if discovery is incomplete, a template does not match the candidate scope/check identity, source provenance is no longer qualified, a digest has changed, or the trigger has reached its configured cap. Concurrent callers acquire an immediate SQLite transaction and receive the same previously promoted policy for the same candidate; only one policy and one promotion event are committed.

Revocation is idempotent. It prevents future overlay selection but does not delete the policy’s candidate evidence, exact template, events, or prior applications. This retention is necessary for auditability.

## Non-Goals

M11 v1 does not add M12 production learning, automatic promotion, policy merging, policy-driven calibration, assurance upgrades, obligation removal, release, or merge authority. No M12 work is part of this stage.
