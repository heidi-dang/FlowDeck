# Milestone 11: Qualified Learned Verification-Policy Overlay Report (R32)

**Status:** `qualified`
**Milestone:** M11
**Frozen M10 baseline (R31):** `96402eefc4d0cd4e6e7c7489c1df5472152e5949`
**Functional candidate stage (F30):** `7d4299c69a7f8412507f64f4bae16ccf4064ee79`
**Functional overlay stage (F31):** `d8f6c1ff4f1cfb34fe47661cba4b07aa934d8568`
**F31 Binary SHA-256:** `729f984ed0325af30af0b029b3534e7fb78c1915737bef09aeb30d6ec34d525c`
**Documentation stage (D32):** `8288a9339d998f7d646de04d82e36cba62162009`
**Harness stage (H33):** `3a0e438c23b9801857fba6685cf75c19289d284a`
**H33 source provenance:** exact F31 only; H33 rejects any other source commit.
**Evidence Graph Schema Version:** `10`
**H33 execution interval:** 2026-08-24T21:04:14.127Z to 2026-08-24T21:04:31.986Z

## Qualification Decision

M11 is qualified as an **additive-only verification-policy overlay**. It accepts only qualified M10 observed-shadow-miss evidence, requires explicit promotion, materializes and binds an immutable exact `PlannedCheck` template, and may then add that check only when its qualified scope is impacted. It does not alter the frozen M6 planner implementation or its direct call path.

> **Decision scope:** This qualification covers M11 v1 only. It does not authorize M12 production learning, autonomous promotion, merge, release, or policy authority in M10 calibration.

| Boundary | Qualified behavior | Evidence |
|---|---|---|
| M10 evidence intake | Current-contract, complete, non-truncated, non-policy-selected physical observed-shadow-miss records only | Named H33 M11 candidate preflights |
| Policy authority | Explicit `ADD_CHECK` promotion only; per-trigger cap; idempotent immediate transaction | Revalidation, cap, and 20-connection concurrency preflights |
| Exact metadata | Canonical persisted `PlannedCheck` template digest, policy digest binding, deterministic source calibration/artifact/record provenance | Template-persistence and tamper-rejection preflights |
| Overlay mutation | Base M6 checks retained; assurance and unresolved obligations byte/semantic-preserved; affected scope only | Monotonic, no-op, missing-template, and CLI fixture preflights |
| Audit and lifecycle | Content-addressed policy application before overlay verification; revocation removes future authority but retains history | Real CLI promotion/plan/verify/revocation preflight |
| Frozen milestone isolation | M6, M7, M8, M9, and M10 contract/isolation preflights pass | 42 named cross-milestone preflights plus full gate |

## F31 Full Qualification Gate

The exact F31 commit completed `PATH=/home/ubuntu/.cargo/bin:$PATH node scripts/pre-push.mjs --full` successfully. The gate covered TypeScript linting, type checking, test suite, packaging, build; Rust formatting, clippy with warnings denied, the complete Rust test inventory, documentation tests, and Rust build. The final gate result was:

```text
✓ All full-mode verification steps passed. Safe to push.
```

The successful full gate occurred before D32/H33/R32 documentation commits. H33 then rebuilt and hashed the F31 binary directly, preventing later documentation commits from being misrepresented as functional binary provenance.

## H33 Named Preflight Evidence

H33 completed **64 named real preflights** with zero failures. The harness record is [`benchmark-fdx-vci-m11-harness.json`](benchmark-fdx-vci-m11-harness.json). The preflight set is organized below for audit navigation; every listed item executed an actual command or exact test filter rather than a synthetic status flag.

| Group | Passed named preflights | Count |
|---|---|---:|
| F31 identity, formatting, clippy, binary build, CLI help | `f31_commit_identity`, `f31_parent_is_f30`, `working_tree_source_clean`, `rust_format`, `rust_clippy`, `fdx_build`, `policy_cli_help`, `plan_overlay_cli_help`, `verify_overlay_cli_help` | 9 |
| M11 candidates, templates, promotion, overlay, schema, CLI | 15 named policy preflights, including qualified-only evidence, template tamper rejection, null/unknown snapshot rejection, 20-connection promotion, cap conflict, and real promotion/verify/revoke fixture | 15 |
| M6 planner and M7 verification contracts | Package planning, non-manufacture, isolation/widening, verification lifecycle, duplicate, output-bound, path-jail, redaction, and unresolved-obligation checks | 13 |
| M8 runtime, M9 attestation, M10 calibration, and protocol isolation | Runtime history/atomicity, predicate/binding/privacy/tamper, calibration reference/measurement/privacy/isolation, and protocol compatibility/path checks | 27 |
| **Total** | **All passed** | **64** |

## Material Findings

The M11 functional implementation adds deterministic candidate identifiers and promotion configuration digests while preventing feedback reinforcement from policy-selected checks. Promotion re-reads qualified evidence inside an `IMMEDIATE` transaction, validates configured support and runtime limits, selects a deterministic qualified source provenance, persists canonical template JSON, and binds both policy identity and policy digest to the template SHA-256.

Active snapshots inspect every persisted policy row before filtering. Null templates, unknown action/state encodings, unsupported lifecycle states, malformed trigger identity, template-policy digest mismatch, missing template rows, corrupt template JSON, scope/check mismatch, and stale source provenance are all rejected. Overlay execution reads the persisted template by its digest and does not rediscover mutable check metadata.

The real CLI fixture demonstrated that a promoted policy can add a discovered format check when M6 did not select it, while default `fdx plan` output remained byte-identical before and after promotion. `fdx plan --policy-overlay` preserved the base assurance and unresolved obligations. `fdx verify --policy-overlay --no-persist` created no policy application; the normal overlay verify created exactly one application. Revocation produced no active policy while retaining two source evidence rows, both policy events, and the application record.

## Non-Regression and Safety Summary

| Protected property | Result |
|---|---|
| Published M10 history and reports | Preserved; no M10 migration v1–v9 or report rewrite |
| Calibration authority | Measurement-only; no policy logic in M10 calibration |
| M6 base planner | Source unchanged; direct default plan path preserved |
| M7/M8/M9 semantics | Frozen contract, isolation, and predicate preflights passed |
| Assurance and unresolved obligations | Preserved exactly by overlay test and real CLI fixture |
| Verification checks | Overlay only adds; base checks cannot be removed or replaced |
| Policy template metadata | Immutable persisted canonical payload, digest-bound and provenance-verified |
| Privacy | Existing verification/calibration/attestation redaction preflights passed |
| M12 | Not started; no production, merge, or release authority introduced |

## Reproduction

The executable harness is [`scripts/benchmark-fdx-vci-m11-harness.mjs`](../scripts/benchmark-fdx-vci-m11-harness.mjs). It is intentionally commit-pinned and must be invoked while `HEAD` is F31:

```bash
PATH=/home/ubuntu/.cargo/bin:$PATH node scripts/benchmark-fdx-vci-m11-harness.mjs
```

It emits the binary-bound JSON record used by this report. For a full repository gate, run:

```bash
PATH=/home/ubuntu/.cargo/bin:$PATH node scripts/pre-push.mjs --full
```

---
*R32 records M11 qualification only. It does not establish or imply any M12 authorization.*
