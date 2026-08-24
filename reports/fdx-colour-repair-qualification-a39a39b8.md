# FDX Parsed-Diff Colour Repair — Source-Bound Qualification

**Status:** Qualification passed; independent fresh-remote gatekeeper review pending.

## Scope and source identity

The qualified functional source is commit `a39a39b86178e0ca54d22644436894e1c8a6574d` on `feat/live-orchestration-runtime`, created by `fix(fdx): force machine-safe parsed diffs`. It is a distinct functional source commit; any later evidence-only commit is not the qualified source.

This repair supersedes the historical qualification of `303d23b61a7a2d1306da4b026997c68915653df7` for the specific FDX inherited-colour defect. The historical artifact remains unchanged. Its prior source was not approved for this issue because an inherited `color.ui=always` setting could inject ANSI bytes into a machine-parsed unified diff and yield zero changed files.

| Boundary | Classification | Result |
|---|---|---|
| `crates/fdx/src/reader/diff.rs` `git diff` stdout | Structured unified diff consumed by `unidiff::PatchSet::parse` | Normalized with `git -c core.quotePath=false diff --no-color --unified=3 …`. |
| `crates/fdx/src/reader/diff.rs` `git show` stdout | Base source consumed by the code parser | Normalized with `git show --no-color …`. |
| `crates/fdx/src/reader/git.rs` `git diff` / `git show` | Read-only, token-limited human display formatter | Not broadened into this repair; it is not the authoritative structured parsed-diff path. |
| `src/tools/fdx.ts` | Public wrapper and fallback delegation | Does not parse unified diffs; no change required. |

The change does not mutate user, repository, or global Git configuration. It does not strip bytes after Git has produced a diff; it asks Git for machine-safe output at the parser boundary. The accompanying direct regression suite uses disposable `tempfile::TempDir` repositories and local repository configuration only.

## Regression proof

The Rust regressions first demonstrate that ordinary `git diff` emits ESC (`0x1b`) bytes when a disposable repository locally sets `color.ui=always` or `color.diff=always`. They then call the production `diff_against` reader and assert the actual parsed result.

| Scenario | Assertion | Result |
|---|---|---|
| Unstaged forced-colour change | Plain Git output contains ANSI ESC bytes; FDX returns one modified file | PASS |
| Staged forced-colour change | Plain Git output contains ANSI ESC bytes; FDX returns one modified file | PASS |
| Multiple paths with spaces and Unicode (`unicode-λ.rs`) | FDX preserves both path identities under forced colour | PASS |
| No-change control | FDX returns an empty result | PASS |
| Existing staged and unstaged cases | Existing reader behavior is retained | PASS |

A small test-only correction in `crates/fdx/tests/test_git.rs` also removes an unrelated assumption that the active branch must be named `main` or `HEAD`. The smoke test now requires a current-branch marker or detached `HEAD`, retaining the behavioral assertion for legitimate feature branches without altering production Git behavior.

## Clean-SHA gates

All gates below were run against the clean functional source before qualification output was created.

| Gate | Result | Recorded evidence |
|---|---|---|
| Rust format and clippy (`-D warnings`) | PASS | Focused FDX gate completed before functional freeze. |
| `cargo test -p fdx` | PASS | Normal and inherited `color.ui=always` executions passed. |
| Native/TypeScript FDX parity | PASS | `npm run test:fdx-parity` passed with native execution proof. |
| Typecheck, lint, docs | PASS | `npm run typecheck`, `npm run lint`, and `npm run validate:docs` passed. |
| Repository tests | PASS | `npm test`: 2,879 passed, 2 pre-existing daemon-injection skips, 0 failed. |
| Coverage | PASS | 84.35% weighted line coverage; threshold 80%. |
| Doctor repair E2E | PASS | 3 passed, 0 failed. |
| Frozen and live schema checks | PASS | Generated-schema checksum, SQLite integrity, and 89/103/38 live schema counts passed. |
| Normal full pre-push | PASS | `node scripts/pre-push.mjs --full` completed with all full-mode steps passing. |
| Forced-colour full pre-push | PASS | Isolated temporary `GIT_CONFIG_GLOBAL` containing `[color] ui = always`; all full-mode steps passed. |

The forced-colour full gate used a temporary file created with `mktemp`, removed by shell trap on exit, and never wrote Git configuration. It is independent of the qualification harness, which does not itself test adversarial Git colour settings.

## Fresh live-runtime qualification

The canonical harness wrote `reports/qualification-live-runtime-a39a39b8.json` from a clean checkout of `a39a39b86178e0ca54d22644436894e1c8a6574d` and returned `overallPassed: true`.

| Qualification check | Result |
|---|---|
| Clean functional SHA | PASS |
| Frozen V1–V14 manifest | PASS; all accepted implementation/support sources match; only the pre-declared forward registration file is excluded. |
| Generated schema | PASS |
| Live schema | PASS |
| Authority, replacement, and continuation regressions | PASS; 93 tests, 0 failures. |
| Doctor observability regressions | PASS; 33 tests, 0 failures. |
| Authority performance | PASS; 997.96 ms, 975.90 ms, 979.89 ms; median 979.89 ms; maximum 997.96 ms; required maximum below 5,000 ms. |

## Boundary

This report records the repair and source-bound qualification only. No Milestone 11 work, merge, release, force push, migration change, CompletionPolicy change, VerificationService change, replacement/continuation redesign, or production Git configuration mutation is included. A separate fresh-remote gatekeeper audit must independently reproduce the coloured-Git condition, re-run both full gates, inspect scope and migration invariants, and issue the final approval verdict.

## Artifacts

| Artifact | Purpose |
|---|---|
| `reports/qualification-live-runtime-a39a39b8.json` | Machine-readable source-bound qualification, including command results and performance samples. |
| `reports/fdx-colour-repair-qualification-a39a39b8.md` | Human-readable repair, gate, and qualification evidence. |
| `/home/ubuntu/live-runtime-ultimate-x5-audit-2026-08-24.md` | Historical pre-repair audit that identified the inherited-colour defect and withheld approval. |

## References

[1]: crates/fdx/src/reader/diff.rs
[2]: crates/fdx/tests/test_diff.rs
[3]: scripts/orchestration/qualify-live-runtime.mjs
[4]: reports/qualification-live-runtime-a39a39b8.json
