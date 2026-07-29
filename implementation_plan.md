# Phase 0.3 - Self-Contained Integration Runner and Canonical Port Discovery

This plan outlines the steps for building the deterministic, self-contained integration matrix runner as approved by the user.

## 1. The Self-Contained Integration Runner (Git Worktree)

- Create `scripts/orchestration/run-integration-matrix.mjs`.
- **SHA Resolution:** Execute `git fetch origin --prune` and resolve `origin/main`, `origin/feat/orchestration-persistence-foundation` (Dev 1), `origin/feat/orchestration-contract-domain` (Dev 2), `origin/feat/orchestration-runtime-domain` (Dev 3), and `HEAD` (Dev 4). Strict 40-character SHAs are enforced.
- **Git Worktree Creation:** Create a unique disposable directory under `${TMPDIR}` using `git worktree add --detach <path> <base-sha>`.
  - An ownership marker `integration-marker.json` will be written containing all SHAs, creator PID, profile, and run ID.
- **Merge Strategy:** Merge requested branches incrementally using `git merge --no-commit --no-ff`. Any merge conflict will be recorded as an integration failure, generating conflict provenance artifacts.
- **Execution & Capture:** Run all validation commands via `child_process.spawn` asynchronously with the `cwd` set to the temporary worktree. Standard outputs, errors, exit codes, and duration will be captured with bounded timeouts.
- **Cleanup:** Cleanup will exclusively use `git worktree remove --force <path>` followed by `git worktree prune`. Filesystem fallback is permitted only after validation of the ownership marker and reporting a secondary error.

## 2. Package Scripts

- Update `package.json` to define explicit integration scripts for all supported profiles (`framework`, `dev1`, `dev2`, `dev3`, `dev1-dev2`, `dev1-dev3`, `dev2-dev3`, `dev1-dev2-dev3`, `all`).
- Maintain isolated framework validation commands that execute purely in the active branch (`test:orchestration:framework`, `test:orchestration:matrix`, `test:orchestration:port-discovery`, `test:orchestration:negative`).

## 3. Compiler-Based Canonical Port Discovery

- Create `tests/orchestration/compliance/port-discovery.test.ts` using the `typescript` compiler API.
- Resolve canonical interfaces (e.g. `EventStore`, `UnitOfWork`) from `src/domain/orchestration` and `src/orchestration`.
- The compiler API will accurately resolve overloads, generics, re-exports, and inheritance without relying on regex.
- Assign canonical ownership accurately: Event-store port to Dev 3, Event-store SQLite adapter to Dev 1; Outbox delivery to Dev 3, Outbox persistence to Dev 1; Runtime state machine to Dev 3.

## 4. Artifact Generation

- Generate strictly validated `compatibility-matrix.json`, `failure-provenance.json`, and `repair-handoff.md`.
- Reject artifacts if they omit 40-char SHAs, possess duplicated interfaces, contain shadow interfaces, or assign ownership incorrectly.

## 5. CI Separation

- Split the `.github/workflows/orchestration-validation.yml` file into independent jobs.
- The `Framework correctness` job must remain green, consisting of framework test suites (`npm run test:orchestration:framework`, etc.).
- The `Integration compatibility` job (`npm run test:orchestration:integration:all`) may remain red, provided artifacts are properly published (using `if: always()`). Do not mask the integration failures.
