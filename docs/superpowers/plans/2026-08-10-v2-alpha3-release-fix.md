# FlowDeck v2.0.0-alpha.3 Release Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct schema validation so the release workflow exercises the discovered SQLite CLI deterministically, then prepare a validated, unpublished v2.0.0-alpha.3 candidate.

**Architecture:** Make schema and embedded-migration paths resolve from the validator module location, pass the discovered SQLite executable explicitly through `execFileSync` argument arrays, and keep Bun as a fallback only when SQLite is genuinely absent. Add a non-publishing release preflight that builds and smoke-tests the exact packed artifact before publication eligibility, then bump authoritative package metadata to alpha.3.

**Tech Stack:** Node.js ESM, Bun tests, npm packaging, GitHub Actions, SQLite/Bun SQLite, Rust FDX crate.

## Global Constraints

- Keep immutable `v2.0.0-alpha.2` pointed at `e6181836bd2f38f972a2a969a881f2e867047e32`.
- Do not create or push any alpha.3 tag, publish npm, create a GitHub release, merge, mark ready, or modify `main`.
- Preserve fail-closed schema validation, package integrity, v2 completion, and coverage >=80%.

### Task 1: Reproduce and lock the schema CLI regression

**Files:**
- Modify: `scripts/check-schema-generated.mjs`
- Test: `tests/check-schema-fallback.test.ts`

- [ ] Run the failing focused test with a fake discovered SQLite executable while the real `sqlite3` command is unavailable/available, recording the alpha.2 failure behavior.
- [ ] Add a regression assertion that the validator executes the injected discovered executable rather than a hardcoded command name.
- [ ] Run the focused test before the implementation and confirm the CI-specific failure is reproduced when `sqlite3` is available.

### Task 2: Implement deterministic schema resource and subprocess handling

**Files:**
- Modify: `scripts/check-schema-generated.mjs`
- Test: `tests/check-schema-fallback.test.ts`

- [ ] Resolve `schema-v0.2.6.sql` and embedded schema paths from the script module directory/repository root, independent of `process.cwd()`.
- [ ] Pass the discovered SQLite executable to validation functions and invoke it with `execFileSync` argument arrays; remove shell redirection/interpolated executable paths.
- [ ] Preserve fail-closed behavior for CLI failures, malformed schemas, missing schema resources, and unavailable CLI/Bun fallback.
- [ ] Run the focused regression and verify both CLI and Bun paths pass.

### Task 3: Add non-publishing release preflight parity

**Files:**
- Create: `scripts/release-preflight.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/publish.yml`
- Test: `tests/release-preflight.test.ts`

- [ ] Add a preflight command that validates package identity/version, runs the canonical build, creates one pack artifact, checks required/forbidden contents, installs that exact artifact in an isolated temp prefix, and runs packaged help/doctor/schema smoke checks.
- [ ] Make the publish workflow invoke the same preflight before registry availability and publish steps, without credentials or publication side effects.
- [ ] Add tests for package-content rejection, exact-artifact smoke execution, and failure ordering before publication.

### Task 4: Prepare alpha.3 metadata and release documentation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Create: `docs/releases/v2.0.0-alpha.3.md`
- Create: `docs/releases/v2.0.0-alpha.3-readiness.json`
- Modify: `scripts/release-alignment.mjs`
- Modify: `scripts/v2-final-gatekeeper.mjs`

- [ ] Update authoritative versions and active release documentation from alpha.2 to alpha.3.
- [ ] Document alpha.2’s immutable failed publication and the schema fallback correction without claiming alpha.2 was published.
- [ ] Generate a machine-readable readiness manifest with `READY_NOT_RELEASED` and the final candidate evidence.

### Task 5: Full verification, independent rejection, and draft PR

**Files:**
- Review all changed files and generated evidence.

- [ ] Run focused regression, release preflight, full tests/coverage, schema, typecheck, lint, build, Rust, docs, skills, package, clean install, and pre-push gates.
- [ ] Reverify alpha.2 tag immutability and absence of alpha.3 tag/npm publication/GitHub release.
- [ ] Perform an independent rejection pass against the release workflow and package artifact.
- [ ] Commit coherent changes, push only `fix/v2-alpha3-release-schema-fallback`, open one draft PR to `v2.0.0-alpha`, and verify exact-head CI.
