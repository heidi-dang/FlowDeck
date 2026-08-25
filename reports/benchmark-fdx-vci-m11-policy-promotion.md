# M11 Corrective Qualification Report — External Release-Binary Policy Promotion (R33)

**Status:** Qualified under the corrective acceptance contract  
**Functional source (F31):** `d8f6c1ff4f1cfb34fe47661cba4b07aa934d8568`  
**External release-binary SHA-256:** `5881aa11c5d7448cf2780bf3e6e80b6db51dd38ac449a593c67f61f8cb105d0b`  
**H34 harness commit:** `b2a59e9e4c15886c3639cbd104cabebb18636452`  
**M11 schema:** `10`  
**Artifact record:** [`benchmark-fdx-vci-m11-policy-promotion.json`](benchmark-fdx-vci-m11-policy-promotion.json)

## Corrective qualification decision

This report supersedes **H33/R32 as the M11 final-acceptance evidence**. The historical F30, F31, D32, H33, and R32 commits remain preserved as immutable history, but H33 is not used as final evidence because it constructed and qualified a debug artifact, mixed generated evidence with the harness stage, included a developer-specific path assumption, and did not execute the required M11 performance suite. H34 and R33 correct those evidence defects without changing F31 production source.

> **Qualification boundary.** H34 accepts only a caller-supplied binary when all three required inputs are present: exact F31 source SHA, binary path, and independently supplied binary SHA-256. It recomputes the binary digest, rejects debug paths, rejects incorrect source or digest inputs, forbids binary construction, and writes only the untracked R33 JSON artifact after a clean H34 checkout has been verified.

| Provenance property | Corrective result |
|---|---|
| Functional source | Exact F31, `d8f6c1ff4f1cfb34fe47661cba4b07aa934d8568` |
| Binary profile | Release, enforced and tested by negative debug-path rejection |
| Binary identity | SHA-256 recomputed and equal to `5881aa11c5d7448cf2780bf3e6e80b6db51dd38ac449a593c67f61f8cb105d0b` |
| Harness ownership | `HEAD == H34` at `b2a59e9e4c15886c3639cbd104cabebb18636452` |
| Production source after F31 | No diff under `crates/fdx/src`, `crates/fdx/Cargo.toml`, or `Cargo.lock` |
| Path privacy | H34/R33 contain no developer-specific absolute path |
| Report sequencing | H34 script only; R33 JSON and Markdown committed separately afterward |

## Semantic qualification

H34 passed **73 named, real preflights**. The inventory covers external release-binary provenance, negative rejection paths, schema v10 migration preservation, candidate qualification, anti-self-reinforcement, explicit promotion, provenance-template integrity, concurrency, cap enforcement, revocation, base-plan monotonicity, default-path isolation, application determinism, CLI lifecycle behavior, and M6–M10 frozen-boundary contracts. Every entry records its exact test or command in the JSON evidence artifact.

| Preflight group | Result | Representative checks |
|---|---:|---|
| External provenance and ownership | 15 passed | Release-only binary, SHA recomputation, debug/wrong-SHA/wrong-source rejection, F31 ancestry, clean H34 ownership |
| M11 candidate and promotion integrity | 13 passed | Qualified M10-only inputs, run-bounded lookback, policy-selected evidence exclusion, self-reinforcement exclusion, 20-connection promotion, cap conflict |
| M11 persisted overlay safety | 5 passed | Exact-template persistence, corrupt-store failure, base-plan preservation, no-op determinism, duplicate-policy deduplication and immutable captured snapshot |
| M11 CLI lifecycle | 1 passed | Explicit promotion, default-plan isolation, verify application persistence, revocation history preservation |
| M6–M10 frozen-boundary regression | 35 passed | Planner, verification, runtime, predicate v1, calibration, protocol, privacy, and transactionality checks |
| **Total** | **73 passed** | Full named inventory in the JSON artifact |

The verification proves M11 remains an **additive-only `ADD_CHECK` overlay**. Candidate generation has no planner authority; qualified M10 evidence is measurement-only; policy-selected future evidence cannot increase its own promotion support; immutable templates and their source provenance fail closed on corruption; and the M6 plan’s selected base checks, assurance, and unresolved obligations are preserved. M12 production work did not begin.

## Performance evidence

All values below are measured by the external release binary on Linux x86_64 using five samples per scenario. They describe this qualification environment, not a cross-machine service-level objective. M10 has a separate workload and is intentionally not used for a direct improvement claim.

| Scenario | Samples | Median ms | P95 ms | Mean ms |
|---|---:|---:|---:|---:|
| Candidate generation, 10 qualified M10 runs | 5 | 56.08 | 70.46 | 59.25 |
| Candidate generation, 100 qualified M10 runs | 5 | 138.04 | 144.37 | 137.83 |
| Candidate generation, 1,000 qualified M10 runs | 5 | 1,063.13 | 1,086.03 | 1,065.82 |
| Active policy snapshot, 0 policies | 5 | 47.52 | 50.37 | 47.67 |
| Active policy snapshot, 10 policies | 5 | 61.91 | 72.36 | 63.42 |
| Active policy snapshot, 100 policies | 5 | 141.35 | 153.16 | 142.78 |
| M6-equivalent base plan, 10 base checks | 5 | 62.97 | 63.87 | 62.70 |
| Empty overlay, 0 active policies | 5 | 65.82 | 67.96 | 64.63 |
| Overlay, 10 base checks and 10 active policies | 5 | 77.39 | 79.70 | 77.74 |
| Overlay, 100 base checks and 100 active policies | 5 | 163.64 | 172.91 | 163.70 |
| Explicit promotion with provenance revalidation | 5 | 59.14 | 60.22 | 59.33 |
| Verify-overlay policy-application persistence | 5 | 517.28 | 536.51 | 521.04 |
| Candidate list query | 5 | 4.79 | 4.86 | 4.76 |
| Candidate show query | 5 | 4.65 | 4.89 | 4.66 |
| Active-policy list query | 5 | 4.82 | 4.87 | 4.71 |
| Explicit revocation | 5 | 64.47 | 68.87 | 65.32 |
| Reopened active-policy snapshot | 5 | 57.96 | 59.68 | 58.09 |

The empty-overlay median overhead over the M6-equivalent baseline was **2.85 ms (4.53%)**. The 10-active-policy and 100-active-policy overlay medians added **14.42 ms (22.90%)** and **100.67 ms (159.87%)**, respectively. These are reported as observed qualification results without presenting them as universal bounds.

## Regression, reproducibility, and toolchain evidence

The main working tree completed three consecutive `node scripts/pre-push.mjs --full` passes after H34. The broader corrective suite also passed: canonical-toolchain Rust formatting, all-feature clippy, and all FDX tests; VCI contracts; FDX parity; TypeScript type checking and linting; documentation validation; fast verification; and the standard pre-push gate.

A hostile-PATH verifier placed a simulated incompatible Cargo shim before the normal path. The repository resolver still selected Cargo `1.98.0` and Rustc `1.98.0`, demonstrating that qualification uses the configured paired toolchain rather than the hostile shim.

An independent detached clean worktree at H34 was also qualified successfully with the same complete gate after installing ignored dependencies and producing the ordinary ignored build artifact required by the repository’s packed-layout doctor tests. A first fresh-layout attempt exposed that prerequisite; a second attempt encountered a linker bus error while the shared filesystem had only 44 MiB free. Generated target artifacts were removed, restoring 34 GiB free, and the clean worktree was rebuilt serially with `CARGO_BUILD_JOBS=1`; the complete gate then passed and the source status remained clean. This operational recovery did not modify source or qualify a different revision.

## Reproduction

The following invocation requires a previously built, independently verified exact-F31 **release** binary. It intentionally has no binary-build fallback.

```bash
FDX_BENCHMARK_FUNCTIONAL_SHA=d8f6c1ff4f1cfb34fe47661cba4b07aa934d8568 \
FDX_BINARY_PATH=/path/to/fdx-release \
FDX_BINARY_SHA256=5881aa11c5d7448cf2780bf3e6e80b6db51dd38ac449a593c67f61f8cb105d0b \
node scripts/benchmark-fdx-vci-m11-policy-promotion.mjs
```

The harness must run at its owning clean H34 checkout. It refuses an incorrect source SHA, a missing artifact, a mismatched binary digest, or a debug-profile path.

## References

[1]: ../scripts/benchmark-fdx-vci-m11-policy-promotion.mjs "H34 external release-binary M11 qualification harness"
[2]: benchmark-fdx-vci-m11-policy-promotion.json "R33 machine-readable M11 qualification evidence"
[3]: ../docs/architecture/fdx-m11-learned-policy-overlay.md "D32 M11 learned-policy overlay contract"
[4]: benchmark-fdx-vci-m11-repro.md "Historical R32 report retained for lineage only"
