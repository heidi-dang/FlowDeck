# CI Infrastructure Fix — Evidence

Record of the pre-existing CI infrastructure failures fixed on
`feat/orchestration-master-plan-completion` (fix commits `ca0ce23` and
`7a4f1b7`), the local validation performed, and the resulting CI gate state.

## Root causes and fixes

| # | Root cause | Failing jobs | Fix |
|---|------------|--------------|-----|
| 1 | On `pull_request`, GitHub sets `GITHUB_SHA` to the ephemeral merge commit while every job checks out `github.event.pull_request.head.sha \|\| github.sha`. `scripts/build-fdx-packages.mjs` strict provenance mode (`CI=true`) rejects the mismatch and fails the build. The guard is a tested contract (`tests/fdx-native-distribution.test.ts` P2-2), so the fix belongs in the workflow. **Iteration 1 (rejected by CI): a job-level `env: GITHUB_SHA:` override is ignored — GitHub reserves `GITHUB_*` variables and the runner's merge-ref value wins in the child process (step header shows the override, the script still sees the merge SHA).** | Build & Validate, Packed CLI ×3, packed-install test in Test Matrix ×3 and Coverage | **Iteration 2 (final):** explicit `export GITHUB_SHA="$(git rev-parse HEAD)"` at the top of the four steps that invoke `build-fdx-packages.mjs` (coverage gate, build pack step, test-matrix test step, packed-cli step). A shell-level export applies at runtime and is inherited by every child process. Test-matrix test step also forced to `shell: bash` for Windows. |
| 2 | The Coverage job had no cargo step, so the `fdx-secure-exec` native helper was never built. `resolveSecureExecHelper` (`src/tools/fdx-shared.ts`) finds nothing and `executeVerifiedSnapshot` refuses to run, failing the 2 resolver tests (~1ms `validateFdxBinaryPath` path). `tests/preload-fdx-secure-exec.ts` was an orphaned auto-build seam (never wired to any preload/bunfig). | Coverage Check ×2 (resolver tests) | Mirror the test-matrix `dtolnay/rust-toolchain@stable` + `cargo build --manifest-path crates/fdx/Cargo.toml` step in the coverage job |
| 3 | Playwright Chromium was never installed on runners. `tests/ui/browser-e2e.test.ts` failed with `Executable doesn't exist at .../chromium_headless_shell-...`. | Coverage Check, Test Matrix ×3 | `npx playwright install chromium` after `npm ci` (`--with-deps` on Linux, plain on macOS/Windows) |
| 4 | **Packed doctor engine (run `30977886891`, commit `5aebd5b`).** Two failures, one root cause: the packaged layout has no working doctor engine. (a) `src/doctor/checks/runtime.ts` imports `../../tools/fdx-shared` → `src/tools/fdx-shared.ts`, which the tarball does not ship (`package.json` `files` omits `src/tools`/`src/lib`/`src/services`). `src/doctor/cli.mjs` ran the bun-inline engine *first* and threw instead of falling back, so the Build & Validate "packed tarball doctor gate" died with `Doctor engine error: Bun v1.3.14 (Linux x64)` (exit 2 — the banner line swallowed the real error). (b) `security.secret_redaction` probes for an importable `redactSecrets`: `dist/tools/fdx-shared.js` (never built), `dist/index.js` (bun-only bundle, `bun:` protocol — not node-importable, and no `redactSecrets` export), `src/tools/fdx-shared.ts`, `src/lib/secret-redaction.ts` (not shipped) — so Packed CLI doctor always failed `Errors: 1` on every OS. | Build & Validate (exit 2), Packed CLI ×3 (exit 1), Windows Test Matrix | **Iteration 3:** build a standalone node-compatible doctor bundle `dist/doctor/doctor.js` (esbuild, `--main-fields=module,main` to pick jsonc-parser's real ESM build — bun's UMD inlining leaves dangling `require2("./impl/format")`; `--outfile` step added to `npm run build`), re-export `redactSecrets`/`containsSecrets` from the bundle entry (`src/doctor/doctor.ts`), probe `dist/doctor/doctor.js` first in `security.ts`, and make `cli.mjs` resolve dist-first (bundle → `dist/index.js` → bun inline, with a real error message on bun failure). Packed CLI's `doctor-service.mjs` Try 1b slot (reserved for this bundle) now resolves under plain node. |

## Local validation

| Check | Command | Result |
|-------|---------|--------|
| Strict-provenance guard fix | `CI=true GITHUB_SHA=$(git rev-parse HEAD) bun test tests/fdx-packed-installation.test.ts` | 2 pass, 0 fail (previously the only local failure under full coverage: 4585 pass / 1 fail) |
| Resolver tests (helper present) | full coverage run, `target/release|debug/fdx-secure-exec` present | 2 resolver tests pass |
| Descent constraint | `tests/benchmarks/evidence-descent.test.ts` (`HEAD~1` → `HEAD`) | green — final commit is artifacts-only |
| Doctor bundle node-importable | `node -e "import('./dist/doctor/doctor.js')"` | `runDoctor`/`redactSecrets`/`containsSecrets`/`formatReport` all functions |
| Engine parity (bundle == bun-inline) | `node src/doctor/cli.mjs` (bundle) vs `bun -e "runDoctor(...)"` (source) | identical summaries (`41 passed / 1 warning / 0 errors / 27 info / 69 total`) |
| **Packed gate repro** (was exit 2) | `npm pack` → extract → `FLOWDECK_PROFILE=minimal node src/doctor/cli.mjs --json --non-interactive --profile minimal` | exit 0, 0 errors, `security.secret_redaction: pass`, exactly 3 repo-only checks skipped |
| **Packed CLI repro** (was exit 1) | installed layout → `node .../bin/flowdeck.js doctor --json --profile minimal` | exit 0, 0 errors, `security.secret_redaction: pass` |
| Doctor test files | `bun test` × 6 doctor/phase30/phase8 files | 149 pass, 0 fail |
| Full suite | `npm run test` (all 210 files) | 4497 pass, 3 fail — all 3 pre-existing on baseline (batch-cache parity ×2, packed-install quota/registry ×1) |
| Typecheck | `bun tsc --noEmit` | clean |

## CI evidence (run `30976784136` on `5f92cfa` — first fix iteration)

- Coverage Check: resolver tests pass, Playwright E2E passes; sole failure = packed-install GITHUB_SHA guard (fixed by iteration 2 export).
- Test Matrix ubuntu/macos: Playwright E2E passes; sole failure = packed-install GITHUB_SHA guard.
- Build & Validate, Packed CLI ×3: single failure each = `build-fdx-packages.mjs` GITHUB_SHA guard.
- Security Scan, Installer Tests, Local Installer ×3, Typecheck, Lint & Typecheck, Runtime Benchmark: pass.

## Pre-existing Windows-only test failures (not infrastructure)

Present in every run including the base (`30904198013`); not introduced by this branch and outside the infra fix scope:

- `tests/fdx-migration.test.ts` — transactional rename of `.fd-plan/my-app` fails on Windows with `os error 32` (file in use by another process).
- `tests/fdx-path-parity.test.ts` — TS project id `normal-repo-a127dcac` vs Rust `normal-repo-7ceeacba` for the same directory (path canonicalization divergence on Windows).
- `tests/ui/browser-e2e.test.ts` — headless Chromium launch hangs to the 60s timeout on the Windows runner (previously failed in ~100ms with no browser installed).

## CI gate state

- Base run `30904198013`: 11 failures (all pre-existing, none introduced by this branch).
- Run `30971987110` on `5710f30`: 9 failures — Rust Gates and Lint & Typecheck fixed by prior commits.
- Run `30976784136` on `5f92cfa`: 8 failures — resolver tests + Playwright fixed; remaining 8 are the GITHUB_SHA guard (4 jobs) and the 4 pre-existing Windows test failures (3 tests + E2E hang). Iteration 2 targets the guard.
- Run `30977886891` on `5aebd5b`: 8 failures — guard fixed; remaining are the doctor engine failures (Build & Validate exit 2, Packed CLI ×3 exit 1, Windows Test Matrix error) plus the pre-existing Windows test failures. Iteration 3 (doctor engine) targets the doctor failures.
- **Run `30990168658` (CI Production Gates) on `04314a2` (iteration 3): all infra/doctor failures fixed.** Build & Validate (incl. the "Packed tarball doctor gate (extracted layout)" step) success; Packed CLI ×3 success on all OSes; Test Matrix ubuntu/macos, Coverage, Typecheck, Lint & Typecheck, Installer Tests, Security Scan, Local Installer ×3, Runtime Benchmark, Rust Gates all success. Sole remaining failure: Test Matrix (windows-latest) — exactly the 3 pre-existing Windows test failures (migration `os error 32`, TS-vs-Rust path parity, browser E2E 60s hang; 4497 tests / 3 fails), which are outside the infra scope. Pipeline Completion fails only because it chains on the Windows matrix.
- Pipeline Completion is a pure downstream gate chain over the upstream jobs and passes once they pass.
