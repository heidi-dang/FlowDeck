# Windows Final Repair — Evidence

Record of the root causes, fixes and CI validation for the three pre-existing
Windows product failures repaired on
`feat/orchestration-master-plan-completion` (PR #113, kept draft).

## Starting state

- Starting SHA: see `starting-sha.txt` (`2fd333e…`).
- Starting runs: see `starting-runs.json`.
- The three failures were present in every CI run since the base
  (`30904198013`) and were the only remaining product failures blocking
  exact-head green CI.

## Root causes and fixes

### 1. `fdx-migration.test.ts` — Windows `os error 32` during rename

- **Root cause**: the FDX `context`/`decisions` commands start with their
  process cwd **inside** the legacy planning directory
  (`~/.fd-plan/<name>`), and the migration renames that directory. Windows
  refuses to rename a directory that is the calling process's own cwd
  (`ERROR_SHARING_VIOLATION`, os error 32). Linux/macOS allow it, which is why
  the test only failed on Windows.
- **Fix** (`16c8acd`): release the cwd pin (`chdir` to `~/.fd-plan`) before
  any rename of the legacy directory, in both the Rust (`paths.rs`) and
  TypeScript (`planning-state-lib.ts`) implementations; bounded retry for
  transient Windows sharing violations only (deterministic limit, doubling
  backoff, structured diagnostics, never retries permission denial); fsync the
  completed temporary destination before activation; TS no longer swallows
  backup/cleanup errors (leftover legacy dir is retried on the next call).
- **Regression coverage**: Rust unit tests (retry classifier, bounded
  attempts, no-retry on permission denial, incomplete-destination recovery,
  idempotent second run, unicode/space/metacharacter names) and integration
  tests that migrate while the process cwd is inside the legacy directory —
  the exact Windows failure mode.

### 2. `fdx-path-parity.test.ts` — TypeScript/Rust project-slug divergence

- **Root cause**: on Windows, bun's `realpathSync` does not resolve 8.3 short
  names (`RUNNER~1`) while Rust's `std::fs::canonicalize` does (both hit the
  same temp paths on the runner), and Rust's lexical `..`-above-root handling
  produced `/..` where `path.resolve` produces `/` — the same directory
  yielded different ids (`normal-repo-a127dcac` vs `normal-repo-7ceeacba`).
- **Fix** (`d0117f7`): one canonical algorithm (v1) documented in
  `docs/project-identity.md`, with expected outputs pinned in the versioned
  shared fixture `fixtures/fdx/project-identity-v1.json` consumed by BOTH
  implementations' tests. TypeScript now uses `realpathSync.native` (libuv —
  resolves 8.3 names exactly like Rust), Rust drops `..` above the root, and
  root/drive-root inputs yield `-<hash>` on both sides. Property tests cover
  determinism, idempotence, separator and drive-case equivalence, and the
  collision corpus; `create_dir` entries are byte-compared TS-vs-Rust against
  real directories.

### 3. `browser-e2e.test.ts` — Windows Chromium hang to the 60s timeout

- **Root cause** (diagnosed via bounded instrumentation): `chromium.launch()`
  hangs under `bun test` on Windows — Bun's Windows child-process pipes never
  complete Playwright's `--remote-debugging-pipe` CDP handshake
  (oven-sh/bun#31105, #27977). The same code succeeds under Node on the same
  machine, which is why the suite hung only on the Windows runner.
- **Fix** (`dd5b6f5`, `5bebf66`, `18e2214`): every lifecycle await is bounded
  and observable (server readiness probe with last-state reporting, bounded
  chromium launch, bounded close with force-kill, orphan-process assertions,
  `SseBroker.closeAll`/`SseManager.dispose` so persistent SSE cannot block
  `server.close()`), the suite serves the built production bundle
  (`dist/ui/mount.js`), and — the definitive fix — the real browser is driven
  through a **node subprocess** (`tests/helpers/browser-driver.mjs`) with
  genuine UI assertions (streamed events, persistent SSE, XSS escaping,
  viewport, ARIA), bypassing the Bun pipe bug entirely.

## CI validation

| Commit | CI Production Gates | Windows Test Matrix |
|--------|---------------------|---------------------|
| `168c734` (fixes 1–3 + config resilience) | migration + parity pass; E2E diagnosed as launch hang (bounded 30s fail, was silent 60s hang) | 3 pre-existing failures gone; launch hang remains |
| `9339974` (+ macOS tmp-root fix) | releaseCwdPin macOS fixed; E2E still hangs on Windows | — |
| `18e2214` (node driver) | **all product tests pass on all OSes**; only the 2 transitional descent-validator tests remain (resolved by the artifacts-only final commit) | 5/5 E2E pass |

- Packed CLI ubuntu/macos/windows, Build & Validate (incl. packed tarball
  doctor gate), Rust Gates, Lint & Typecheck, Typecheck, Installer Tests,
  Security Scan, Local Installer ×3, Runtime Benchmark, FDX Native Parity, FDX
  Index Benchmark, Orchestration Validation: **success** on `18e2214`.
- The only non-code failure observed (`Build FDX (darwin-x64)` artifact
  upload) was GitHub Actions results-API infra flakiness — the build itself
  succeeded and the duplicate run passed.
- Final exact-head runs (after the artifacts-only evidence commit): see
  `final-runs.json` (stored with the run evidence in the PR description, kept
  outside the branch so the validated head is not mutated).
