# FlowDeck FDX VCI M12 Final Qualification Report

## Decision

**Status: QUALIFIED.** H36 completed final M12 qualification against an independently built, externally supplied release binary from exact F32 source. The harness completed **102 meaningful preflights** and recorded deterministic local-capability and end-to-end policy-provenance lifecycle measurements. The machine-readable companion is [`benchmark-fdx-vci-m12-final.json`](./benchmark-fdx-vci-m12-final.json).

> This report closes the defined VCI roadmap only. It does not introduce a new learning algorithm, migration, network service, signing system, or work beyond M12.

| Evidence item | Recorded value |
|---|---|
| Functional source | F32 `7081df5140df5449253da0baa31153a50777668b` |
| Harness / qualification head | H36 `6546231bfb4c830c2fd9128bdef24851035a5e52` |
| Binary source | Exact F32 |
| Binary profile | `release` |
| Binary SHA-256 | `b42ebb9600b4f01a5cc08316929629725ed778c925079d105d79df2c3e4b1a7d` |
| Binary size | 18,008,488 bytes |
| Rust host | `x86_64-unknown-linux-gnu` |
| Cargo / Rustc | 1.98.0 / 1.98.0 |
| Graph schema | 10 |
| External-binary contract | Mandatory source SHA, binary path, and binary SHA; no autobuild |
| Qualification checkout | Clean; F32 ancestor of H36; no production-path diff after F32 |

## Methodology and External-Binary Boundary

H36 requires `FDX_BENCHMARK_FUNCTIONAL_SHA`, `FDX_BINARY_PATH`, and `FDX_BINARY_SHA256`. It rejects a debug-path binary, an incorrect binary digest, and an incorrect functional-source digest before the workload begins. The supplied release bytes were independently rebuilt from a detached exact-F32 worktree and the harness recalculated their SHA-256. The report intentionally omits any absolute local binary path.

Fixture preparation is measured separately from each target operation. Low-latency workloads use 15 samples; the 1,000-qualified-calibration workload uses 7 samples. Consequently, setup time must not be read as command-operation time. The report makes **no cross-milestone performance-improvement claim**; M10 and M12 scenarios differ.

| Qualification preflight group | Result |
|---|---|
| Exact F32 / release / SHA provenance and rejection controls | Passed |
| H36 ownership, F32 ancestry, clean checkout, and post-F32 production-diff audit | Passed |
| Rust toolchain resolver and external binary CLI availability | Passed |
| M6–M11 semantic, isolation, additive-overlay, calibration, persistence, and safety checks | Passed |
| M12 capability, v2 schema/dispatch, policy binding/revocation, and CLI selection checks | Passed |
| Attestation canonicalization, integrity anchoring, path/jail, TOCTOU, privacy, tamper, and completeness suites | Passed |
| Total meaningful preflights | **102 passed** |

## M12 Functional Closure

Predicate v1 remains the strict default create path. Predicate v2 retains the in-toto Statement v1 envelope and adds policy context only for a run whose plan contains learned-policy additions. The final lifecycle workload exercised M6/M7 verification with an M11 overlay, creation of a default v1 statement and explicit v2 statement, v2 verification, subsequent policy revocation, and successful historical v2 verification. It also confirmed mixed-version list classification.

| Predicate and capability contract | Final behavior |
|---|---|
| Predicate v1 | URI `https://flowdeck.dev/attestation/vci/verification/v1`; schema 1; default create behavior preserved |
| Predicate v2 | URI `https://flowdeck.dev/attestation/vci/verification/v2`; schema 2; explicit `--predicate-version v2` selection |
| v2 policy provenance | Base/effective plan, application, snapshot, policy, template, action, and canonical added-check bindings verified fail-closed |
| Historical revocation | A policy revoked after application did not invalidate a reproducible historical v2 attestation |
| Capability contract | Version 1; predicates `v1`, `v2`; graph-schema maximum write 10; no network access; no telemetry |
| M10 / M11 safety | M10 measurement-only and M11 `ADD_CHECK`-only boundaries retained |
| Persistence | Content-addressed atomic persistence; strict version-dispatched v1/v2 loader; unknown predicate URI and unknown fields rejected |

## Timed Workloads

The following metrics are CLI-inclusive operation times after fixture setup. They are measured on the Linux host above and should be interpreted as qualification evidence for that environment, not a cross-platform performance commitment.

| Workload | Samples | Setup median | Operation median | Operation p95 | Verified fixture outcome |
|---|---:|---:|---:|---:|---|
| M11 overlay verify with application persistence | 15 | 72.69 ms | 299.60 ms | 322.19 ms | Exactly one persisted policy application and verification execution |
| M12 v2 policy-provenance lifecycle | 15 | 72.57 ms | 423.70 ms | 442.36 ms | v1 default, v2 context, post-revocation historical verify, mixed-version list all true |
| M12 local capabilities CLI | 15 | 0.00 ms | 3.23 ms | 3.99 ms | Contract 1, predicates `v1`/`v2`, schema write max 10, network false, telemetry false |
| Reopen active-policy list | 15 | 101.50 ms | 7.05 ms | 8.30 ms | Ten active policies loaded after reopen |

## Migration, Privacy, Offline, and Platform Evidence

The pre-M12 migration inventory was recomputed after F32 and matched exactly: `migration.rs`, `schema.rs`, and the runtime, calibration, and policy schema files were unchanged. M12 therefore uses existing schema v10 and introduces no v11 migration. The strict loader and its test suites reject malformed, unknown, tampered, non-canonical, or future predicate documents. The qualification inventory also covers secret/excerpt redaction, managed-path boundaries, bounded reads, integrity anchors, and TOCTOU/jail safety.

The capability document is local deterministic authority with `network_access: false` and `telemetry: false`; the lifecycle tests use only disposable local repositories, a local external binary, and embedded SQLite evidence. **Linux** on `x86_64-unknown-linux-gnu` is the platform tested for this report. macOS and Windows are represented by deterministic capability limitations but were not executed in this qualification run.

## Relationship to the Frozen M11 Evidence

H35 `a1bd16ef930eb0f9b0d7fdc1caede6534b4b9bd0` and R34 `5cfc8cad98476140b46900a07eae56dbe8a179d5` remain the accepted M11 benchmark-methodology correction and freeze. H36/R35 neither modify M11 production source nor replace that evidence. M12 starts at F32 and binds persisted M11 authority without changing M11’s explicit additive-only contract.

## References

[1] [Machine-readable H36/R35 evidence](./benchmark-fdx-vci-m12-final.json)

[2] [H36 final qualification harness](../scripts/benchmark-fdx-vci-m12-final.mjs)

[3] [M12 architecture and compatibility guide](../docs/architecture/fdx-m12-verifiable-change-intelligence.md)

[4] [Accepted M11 H35/R34 report](./benchmark-fdx-vci-m11-policy-promotion.md)
