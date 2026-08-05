# CI Infrastructure Fix — Evidence

Record of the pre-existing CI infrastructure failures fixed on
`feat/orchestration-master-plan-completion` (commit `ca0ce23`), the local
validation performed, and the resulting CI gate state.

## Root causes and fixes

| # | Root cause | Failing jobs | Fix |
|---|------------|--------------|-----|
| 1 | On `pull_request`, GitHub sets `GITHUB_SHA` to the ephemeral merge commit while every job checks out `github.event.pull_request.head.sha \|\| github.sha`. `scripts/build-fdx-packages.mjs` strict provenance mode (`CI=true`) rejects the mismatch and fails the build. The guard is a tested contract (`tests/fdx-native-distribution.test.ts` P2-2), so the fix belongs in the workflow. | Build & Validate, Packed CLI ×3, packed-install test in Test Matrix ×3 and Coverage | Job-level `env: GITHUB_SHA: ${{ github.event.pull_request.head.sha \|\| github.sha }}` on the 4 jobs that invoke `build-fdx-packages.mjs` (coverage, test-matrix, build, packed-cli-matrix) |
| 2 | The Coverage job had no cargo step, so the `fdx-secure-exec` native helper was never built. `resolveSecureExecHelper` (`src/tools/fdx-shared.ts`) finds nothing and `executeVerifiedSnapshot` refuses to run, failing the 2 resolver tests (~1ms `validateFdxBinaryPath` path). `tests/preload-fdx-secure-exec.ts` was an orphaned auto-build seam (never wired to any preload/bunfig). | Coverage Check ×2 (resolver tests) | Mirror the test-matrix `dtolnay/rust-toolchain@stable` + `cargo build --manifest-path crates/fdx/Cargo.toml` step in the coverage job |
| 3 | Playwright Chromium was never installed on runners. `tests/ui/browser-e2e.test.ts` failed with `Executable doesn't exist at .../chromium_headless_shell-...`. | Coverage Check, Test Matrix ×3 | `npx playwright install chromium` after `npm ci` (`--with-deps` on Linux, plain on macOS/Windows) |

## Local validation

| Check | Command | Result |
|-------|---------|--------|
| Strict-provenance guard fix | `CI=true GITHUB_SHA=$(git rev-parse HEAD) bun test tests/fdx-packed-installation.test.ts` | 2 pass, 0 fail (previously the only local failure under full coverage: 4585 pass / 1 fail) |
| Resolver tests (helper present) | full coverage run, `target/release|debug/fdx-secure-exec` present | 2 resolver tests pass |
| Descent constraint | `tests/benchmarks/evidence-descent.test.ts` (`HEAD~1` → `HEAD`) | green — final commit is artifacts-only |

## CI gate state

- Base run `30904198013`: 11 failures (all pre-existing, none introduced by this branch).
- Run `30971987110` on `5710f30`: 9 failures — Rust Gates and Lint & Typecheck fixed by prior commits; the remaining 9 are covered by the fixes above.
- Pipeline Completion is a pure downstream gate chain over the upstream jobs and passes once they pass.
