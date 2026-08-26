# Heidi ↔ FDX Native-Authority Integration Closure

**Status:** Qualified for normal push, subject to the remote-parity check recorded below.

**Functional source revision:** `a8aef3e16d5cda370e3886a8b45db89fef0bc376`

**Target branch:** `feat/heidi-fdx-vci-integration`
**Qualification record:** [H41 strict native-only report][1]

> **Acceptance rule.** H41 accepts only a real release-profile FDX binary running against a clean source revision. Fallback, seeded storage, simulated evidence, skipped cases, malformed output, and an unavailable binary are all non-acceptance conditions.[1]

## Executive conclusion

The Heidi integration now treats **native FDX as the sole authority for completion-grade VCI evidence**. TypeScript remains responsible for orchestration, process transport, parsing, state binding, lifecycle handling, and presentation; it does not reconstruct M6/M7 truth, manufacture M8 evidence, or treat fallback execution as completion evidence. The frozen FDX M1–M12 source lineage was preserved: no files under `crates/fdx/` changed from the audited branch baseline through the functional integration commits.

H41 completed **11 of 11** strict native scenarios with **0 failures** and a score of **10.0/10.0** on Linux x64. It was run on a clean checkout of the functional source revision using FDX `0.1.0`, protocol `2`, graph schema write maximum `10`, graph schema readable minimum `1`, capability contract `1`, calibration contract `2`, policy contract `1`, and attestation predicates `v1` and `v2`.[1]

| Qualification attribute | Result |
|---|---:|
| H41 strict native scenarios | 11 / 11 passed |
| H41 acceptance score | 10.0 / 10.0 |
| Native binary | `fdx 0.1.0` release profile |
| Binary SHA-256 | `4878e5f5845c3b963cedafdfd253a668559aed2ae8a62dd66fa8beb149300031` |
| Binary size | 18,083,176 bytes |
| Tested platform | Linux x64 only |
| Frozen FDX source changes in functional integration range | None |

## Remediation traceability

The following table maps the ten authority blockers to their cause, remediation, regression evidence, and final disposition. The test and harness names are part of the repository evidence set; H41 results are preserved in the adjacent JSON report.[1]

| ID | Blocker and root cause | Primary remediation files | Regression evidence | Result |
|---|---|---|---|---|
| B1 | TypeScript hand-maintained protocol/schema literals could drift from frozen Rust authority. | `scripts/generate-fdx-vci-contract.mjs`, `src/generated/fdx-vci-contract.ts`, `src/services/fdx-vci-contracts.ts` | `fdx-vci-contract-generator.test.ts`; `check:fdx-vci-contract` | Generated contract is checked against frozen Rust constants and fails when stale. |
| B2 | Completion provider could allow TypeScript fallback execution to approach a completion result. | `src/orchestration/verification/fdx-verification-provider.ts` | `heidi-fdx-vci.test.ts`; native authority fallback containment test | Non-`native_vci_full` states return an error with no evidence IDs. |
| B3 | Native persistence uncertainty could leave a locally reconstructed digest usable as evidence. | `src/services/fdx-vci-adapter.ts` | `fdx-native-authority.test.ts` M8/M9 containment; H41-06 | Completion-grade evidence requires a native `persisted` receipt, existing artifact, and full SHA-256 of artifact bytes. Failure paths carry no native evidence digest. |
| B4 | Attestation could be attempted before M8 eligibility or a failed attestation could be under-signaled. | `src/orchestration/verification/fdx-verification-provider.ts`, `src/services/fdx-vci-adapter.ts` | `fdx-native-authority.test.ts` M8→M9; H41-07 and H41-10 | M9 is withheld until M7/M8 evidence is eligible; verified native attestation is required for pass; failure returns no evidence IDs and an attestation blocker. |
| B5 | Repository identity omitted dirty-byte coverage beyond a fixed prefix and had nondeterministic fallback behavior. | `src/services/fdx-vci-adapter.ts` | Content-bound fingerprint regressions; H41-11 | Fingerprint binds HEAD, staged and working binary diffs, full-streamed relevant untracked content, deletion, rename, and restoration; non-repositories fail closed. |
| B6 | Doctor severity was too permissive for missing native authority and incompatible protocol. | `src/doctor/checks/fdx.ts` | `doctor-checks-fdx.test.ts` | Missing native FDX and protocol mismatch are authoritative VCI errors, not qualifying warnings. |
| B7 | Native authority tests could silently skip or inherit another suite’s deliberately absent binary path. | `tests/fdx-native-authority.test.ts` | Full `npm test`: 3,035 pass, 0 fail; bundled-fixture isolation test path | The suite requires an existing bundled binary and ignores an absent injected path in favor of the bundled fixture. |
| B8 | M10 recovery could collapse or infer per-check state from an aggregate run. | `src/orchestration/verification/fdx-recovery.ts` | Exact per-check truth regressions; H41-08 | Calibration accepts only one exact native `passed`/`failed` result for every planned check; unknown, missing, duplicate, inconsistent, or persistence-failed evidence is rejected. |
| B9 | Parseable partial stdout from a nonzero native process or malformed per-check JSON could be consumed. | `src/services/fdx-vci-adapter.ts` | Hostile nonzero-with-JSON and unknown-status regressions | Nonzero exit, missing run ID/checks, unknown outcome/status, duplicate/unplanned checks, missing coverage, and inconsistent `passed` output fail closed. |
| B10 | Historical H40 included fallback and directly seeded simulation cases in an aggregate success score. | `scripts/qualify-heidi-fdx-native-authority-strict.mjs`, `reports/heidi-fdx-native-authority-strict-h41.json` | H41-01 through H41-11 | Historical evidence is preserved, while H41 is segregated and accepts only native release-binary evidence. |

## Native qualification coverage

H41 created a disposable Git repository and invoked the actual release binary through the same adapter and production-provider paths that FlowDeck uses. It verified native capability negotiation, M1–M5 change intelligence, M6 digest origin, M7 command execution, M8 artifact durability, M9 v1 attestation creation and verification, M10 native calibration, the native M11 candidate surface, the production completion provider, and stale evidence after a repository mutation.[1]

| H41 scenario | Native validation | Outcome |
|---|---|---|
| H41-01 | Release binary SHA-256, release path, clean functional source | Pass |
| H41-02 | Protocol/schema/capability/predicate contracts; no network or telemetry | Pass |
| H41-03 | Capability negotiation resolves `native_vci_full` without fallback | Pass |
| H41-04 | M1–M5 identifies a real dirty source file | Pass |
| H41-05 | M6 plan has FDX-owned 64-character base/effective digests | Pass |
| H41-06 | M7 result is passed; M8 artifact exists and its full SHA-256 matches evidence | Pass |
| H41-07 | Native v1 attestation file is created and independently verified | Pass |
| H41-08 | Native `calibrate run` completes with contract version 2 and exact check truth | Pass |
| H41-09 | Native M11 candidate and active-policy queries run without fabricated policy state | Pass |
| H41-10 | Production provider passes only with native M7/M8/M9 evidence and verified attestation | Pass |
| H41-11 | Post-verification repository mutation changes the bound fingerprint | Pass |

## Release gate record

The full local release-gate record is summarized below. The initial full test run exposed six failures in the native authority test file due to a cross-suite environment fixture that intentionally set `FDX_BINARY_PATH` to a nonexistent binary. This was repaired by selecting the existing bundled fixture when an injected path does not exist. The entire suite was then rerun; its final disposition is the one reported here.

| Gate | Final disposition |
|---|---|
| Native generated-contract freshness | Pass |
| Lint | Pass; 0 warnings and 0 errors |
| TypeScript typecheck | Pass |
| Focused integration suite | Pass; 187 tests, 0 failures |
| Full `npm test` rerun | Pass; 3,035 passed, 5 intentionally skipped daemon tests, 0 failed |
| Production build | Pass |
| Documentation validation | Pass |
| Package dry run | Pass; package `@heidi-dang/flowdeck@2.5.0` assembled successfully |
| Rust format check | Pass |
| Rust clippy (`-D warnings`) | Pass |
| Rust crate tests | Pass |
| Rust release build | Pass |
| H41 strict native qualification | Pass; 11/11, 10.0/10.0 |

## Scope, risks, and release conditions

The qualification is intentionally **platform-specific**. The tested release binary and H41 evidence cover Linux x64 only; the native capability report itself declares that limitation.[1] Windows and macOS binaries remain outside this execution record and require equivalent release-binary qualification before a cross-platform claim is made.

The regular repository test command intentionally skips five resident-daemon tests because their daemon binary is not available in this environment. These skips are unrelated to the native CLI authority path qualified by H41, but they are disclosed rather than converted into passing evidence. The strict H41 harness rejects missing binaries rather than skipping them.

The remote branch was audited immediately before final push preparation: `origin/feat/heidi-fdx-vci-integration` was at `5b3e838cc6fbbc1b126604990e8e347e579cb20a`, while the functional integration revisions are `8ab68a5a49946972ce50ee3ad2b6b83f740301d2` and `a8aef3e16d5cda370e3886a8b45db89fef0bc376`. Normal push and post-push remote equality verification are required next; no merge or force-push is authorized by this report.

## Evidence references

[1]: ./heidi-fdx-native-authority-strict-h41.json "H41 strict native-only qualification record"
[2]: ../scripts/qualify-heidi-fdx-native-authority-strict.mjs "H41 qualification harness"
[3]: ../tests/fdx-native-authority.test.ts "Native authority and hostile-boundary regression suite"
[4]: ../src/services/fdx-vci-adapter.ts "Heidi–FDX native integration boundary"
[5]: ../src/orchestration/verification/fdx-verification-provider.ts "Completion-grade FDX verification provider"
[6]: ../src/orchestration/verification/fdx-recovery.ts "Exact M10 calibration recovery boundary"
