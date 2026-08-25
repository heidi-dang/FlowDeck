## Summary

This pull request completes the bounded **Repo Master** integration for FlowDeck 2.5.0. Repo Master is advisory repository intelligence only: it reuses the existing FDX workspace index and repository hot context, keeps run-specific advice in canonical routing evidence, and does not introduce a scheduler, execution engine, second index, model router, completion authority, verification authority, or recursive agent.

Heidi remains the orchestration authority. `SpecialistPlan` remains the sole authority for specialist target normalization, deduplication, dependency ordering, fan-out caps, and inherited model/tool policy. Direct work bypasses heavyweight consultation; repository-significant work can consult bounded advice and revalidates it before native specialist dispatch.

The branch also includes bounded cache/freshness persistence, fail-closed corruption handling, restart and repository isolation coverage, cancellation/replacement/modification hardening, aggregate telemetry and snapshot diagnostics, adaptive-mode/resource qualification, a 2.5.0 version bump, a complete README, and release documentation. SQLite lifecycle handling now finalizes statements where supported and uses an explicit lifecycle barrier before database closure. The Repo Master performance contract retains its latency assertions while allowing the observed Windows execution variance through a documented per-test timeout budget, with no sleeps, retries, skips, or weakened assertions.

## Qualification

| Check | Result |
| --- | --- |
| Final functional SHA | `cfa31b2d77c42a5c364c4cced158cacb6c789095` |
| Normal-color full gate | Passed: 2,915 pass, 2 explicit environment-dependent skips, 0 fail across 272 files |
| Forced-color full gate | Passed: 2,915 pass, 2 explicit environment-dependent skips, 0 fail across 272 files |
| Fresh GitHub clone, `npm ci`, and full gate | Passed: 2,912 pass, 5 explicit native-daemon environment-dependent skips, 0 fail; 84.65% weighted aggregate line coverage |
| Remote PR checks | Passed: 21 successful, 0 failing, 0 cancelled, 0 pending, 0 skipped |
| Remote platform coverage | Ubuntu, macOS, and Windows test matrices passed; Windows passed after the bounded Repo Master timeout remediation |
| Build and quality gates | Lint, typecheck, coverage, documentation, package dry run, build, installers, packed CLI, security, Rust/FDX, and orchestration validation passed |
| Independent gatekeeping | P0 = 0, P1 = 0, score = 9.7 / 10 |

The separate report-only commit records the source-bound qualification result. The implementation and test source is frozen at the functional SHA above; the report-only evidence commit updates only `docs/releases/v2.5.0-qualification.md`.

## Review focus

Please review the advisory-only authority boundary, routing-evidence persistence, freshness and invalidation handling, lifecycle barriers across restart/cancellation/replacement, and dispatch revalidation. Verification and completion retain exclusive authority under their existing services. This PR targets `main`, remains open for review, and is intentionally **not merged** by this change.
