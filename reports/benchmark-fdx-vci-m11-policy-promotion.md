# M11 Final Benchmark Qualification — Corrected Methodology (R34)

**Status:** **ACCEPTED / FROZEN**
**Functional source (F31):** `d8f6c1ff4f1cfb34fe47661cba4b07aa934d8568`  
**External release-binary SHA-256:** `5881aa11c5d7448cf2780bf3e6e80b6db51dd38ac449a593c67f61f8cb105d0b`  
**H35 harness commit:** `a1bd16ef930eb0f9b0d7fdc1caede6534b4b9bd0`
**Schema version:** `10`
**Machine-readable evidence:** [`benchmark-fdx-vci-m11-policy-promotion.json`](benchmark-fdx-vci-m11-policy-promotion.json)

## Corrective acceptance decision

R33’s **semantic and provenance qualification remains valid**: it correctly demonstrated external exact-F31 release-binary provenance, fail-closed policy semantics, and the M11 safety contract. This R34 report supersedes R33 **only for M11 performance and benchmark-methodology acceptance**. R33’s earlier benchmark labels implied base-plan cardinalities and narrower operation boundaries that its fixture construction did not establish. H35 corrects those measurements without altering F31 production code.

> **Freeze decision.** H35 passed 74 meaningful preflights against an externally supplied exact-F31 release binary. It records no F31-to-H35 FDX production diff, uses no binary auto-build path, recomputes the supplied SHA-256, rejects debug/wrong-SHA/wrong-functional-source inputs, and separates fixture setup from every operation metric. M11 is therefore accepted and frozen at the conclusion of R34.

| Corrected property | H35 result |
|---|---|
| Functional source | Exact F31 `d8f6c1ff4f1cfb34fe47661cba4b07aa934d8568` |
| Release artifact | External only; 17,798,824 bytes; SHA-256 `5881aa11c5d7448cf2780bf3e6e80b6db51dd38ac449a593c67f61f8cb105d0b` |
| Harness ownership | H35 `a1bd16ef930eb0f9b0d7fdc1caede6534b4b9bd0` from a clean checkout |
| Production diff after F31 | Empty for `crates/fdx/src`, `crates/fdx/Cargo.toml`, and `Cargo.lock` |
| External contract | Requires `FDX_BENCHMARK_FUNCTIONAL_SHA`, `FDX_BINARY_PATH`, and `FDX_BINARY_SHA256`; no fallback build |
| Semantic preflights | 74 passed, including a timer-boundary assertion and all prior M6–M11 isolation preflights |
| Sample quality | 15 samples for low-latency operations; 7 samples for the 1,000-run candidate scenario |

## Corrected methodology

Each H35 sample first creates the disposable repository, initializes SQLite, and seeds its qualified calibration or active-policy fixture. H35 records that duration under `setup_ms`. Only after this preparation ends does it begin `operation_ms`; repository deletion happens after the operation timer stops. An in-process preflight injects a setup-only delay and fails if that delay leaks into the target operation timing.

Candidate and active-policy figures are explicitly named **CLI end-to-end** timings because they include process launch and command execution. The former `policy_application_persistence_ms` claim is removed: its replacement is `verify_overlay_e2e_with_application_persistence`, whose fixture explicitly records that verification execution is included. No metric is presented as isolated persistence latency.

| Metric family | Actual timed operation | Setup excluded? | Boundary label |
|---|---|---:|---|
| Candidate generation | `fdx policy generate-candidates --format json` | Yes | `candidate_generation_cli_e2e` |
| Active policy list | `fdx policy list-active --format json` | Yes | `active_policy_list_cli_e2e` |
| Base/effective planning | `fdx plan … --format json`, with optional `--policy-overlay` | Yes | `overlay_planning_cli_e2e` |
| Promotion | `fdx policy promote-candidate …` | Yes | `promotion_cli_e2e_with_provenance_revalidation` |
| Verification/application record | `fdx verify --policy-overlay …` | Yes | `verify_overlay_e2e_with_application_persistence` |
| Reopen/list | New CLI process and active-policy query | Yes | `connection_reopen_plus_active_policy_list_cli_e2e` |

## Real plan and policy cardinalities

H35 constructs actual distinct discovered test checks for its base plans and one distinct exact persisted template, qualified provenance record, candidate, and active `ADD_CHECK` policy for every policy row. The harness reads the actual plan result and fails if any advertised cardinality differs.

| Scenario | Base selected checks | Active policies | Distinct policy checks | Effective selected checks | Added checks | Samples | Operation median ms | Setup median ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `base_10_checks` | 10 | 0 | 0 | 10 | 0 | 15 | 41.11 | 48.05 |
| `overlay_10_base_plus_10_policy_checks` | 10 | 10 | 10 | 20 | 10 | 15 | 43.93 | 101.46 |
| `base_100_checks` | 100 | 0 | 0 | 100 | 0 | 15 | 199.59 | 52.19 |
| `overlay_100_base_plus_100_policy_checks` | 100 | 100 | 100 | 200 | 100 | 15 | 212.09 | 568.48 |

The `100`-check overlay therefore denotes a real 100-check M6 base plan plus 100 distinct active policy additions, not 100 duplicate rows that collapse into a smaller effective plan.

## Operation metrics

These observed figures describe the qualification environment—Linux x86_64, Cargo/Rustc 1.98.0—and are not universal service-level bounds. M10 benchmarks remain separately qualified under a different workload; no cross-milestone performance comparison is claimed.

| Operation | Fixture cardinality | Samples | Operation median ms | P95 ms | Setup median ms |
|---|---|---:|---:|---:|---:|
| Candidate generation CLI E2E | 10 qualified runs | 15 | 9.13 | 9.82 | 59.27 |
| Candidate generation CLI E2E | 100 qualified runs | 15 | 15.41 | 16.08 | 136.76 |
| Candidate generation CLI E2E | 1,000 qualified runs | 7 | 711.97 | 751.63 | 524.91 |
| Active policy list CLI E2E | 0 active policies | 15 | 6.42 | 7.59 | 49.71 |
| Active policy list CLI E2E | 10 active policies | 15 | 7.08 | 7.54 | 96.35 |
| Active policy list CLI E2E | 100 active policies | 15 | 9.12 | 11.33 | 560.18 |
| Promotion CLI E2E with provenance revalidation | Exact template-bound candidate | 15 | 9.79 | 10.66 | 58.90 |
| Verify overlay E2E with application persistence | One persisted application; verification included | 15 | 279.08 | 338.29 | 70.37 |
| Connection reopen plus active-policy list CLI E2E | 10 active policies | 15 | 7.30 | 8.46 | 99.39 |

## Safety and frozen-boundary confirmation

The H35 preflight inventory retains the M11 safety evidence: only qualified non-policy M10 observed shadow misses can support candidates; policy-selected future observations cannot self-reinforce support; promotion binds a canonical exact template and provenance; active snapshots and corrupted bindings fail closed; duplicate policy additions deduplicate; revocation prevents future additions while preserving historical evidence and applications; base M6 checks remain present; assurance never increases; and unresolved obligations remain preserved.

The historical F30, F31, D32, H33, R32, T34, H34, and R33 commits remain unmodified. H35 changes **only** benchmark methodology in `scripts/benchmark-fdx-vci-m11-policy-promotion.mjs`; R34 changes **only** this report pair. M10 remains measurement-only. M11 remains explicit `ADD_CHECK` only. M12 production authority begins only after this R34 freeze point.

## Reproduction

H35 requires an independently built exact-F31 **release** binary. It will not build or select one automatically.

```bash
FDX_BENCHMARK_FUNCTIONAL_SHA=d8f6c1ff4f1cfb34fe47661cba4b07aa934d8568 \
FDX_BINARY_PATH=/path/to/fdx-release \
FDX_BINARY_SHA256=5881aa11c5d7448cf2780bf3e6e80b6db51dd38ac449a593c67f61f8cb105d0b \
node scripts/benchmark-fdx-vci-m11-policy-promotion.mjs
```

The harness requires a clean checkout at its owning H35 commit, rejects a debug path or mismatched SHA/source, and emits only the untracked R34 JSON artifact.

## References

[1]: ../scripts/benchmark-fdx-vci-m11-policy-promotion.mjs "H35 corrected external release-binary benchmark harness"
[2]: benchmark-fdx-vci-m11-policy-promotion.json "R34 machine-readable M11 benchmark evidence"
[3]: ../docs/architecture/fdx-m11-learned-policy-overlay.md "M11 learned-policy overlay contract"
[4]: benchmark-fdx-vci-m11-repro.md "Historical R32 qualification report"
