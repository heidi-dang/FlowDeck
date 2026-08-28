# FDX

FDX is FlowDeck's Rust-native, local-first code-intelligence and verification CLI. It gives agents and developers fast repository navigation, semantic code analysis, change-impact intelligence, evidence-backed test planning, bounded verification execution, historical runtime evidence, and deterministic verification attestations.

## What is FDX?

FDX is a high-performance developer and agent companion designed to understand codebases from first principles. Rather than relying on cloud services or slow whole-repo re-indexing, FDX computes deterministic evidence graphs locally from Git history, AST parsers (tree-sitter), build configurations, and language indexers.

It serves as the execution and verification engine of FlowDeck, providing safe, bounded primitives that verify code changes with cryptographic auditability.

## Why FDX?

Modern development workflows—especially those orchestrated by autonomous agents—require fast, precise answers to critical questions:
- *What changed semantically across revisions?*
- *Which downstream packages, modules, and tests are actually affected?*
- *What is the minimal set of tests needed to verify this change?*
- *Did a test run physically execute, and what exact outputs were produced?*
- *Can we generate tamper-evident, reproducible proof of verification?*

FDX answers these questions without guesswork:

- **Local-First:** All indexing, graph analysis, and attestation generation run entirely offline with zero external network dependencies.
- **Agent-Native:** Output formats support concise token-optimized text for LLM contexts as well as structured JSON for automated pipelines.
- **Polyglot:** Built-in tree-sitter parsers for Rust, TypeScript, JavaScript, Python, and Java, alongside build graph analysis for Cargo, npm/Bun/pnpm, and Maven/Gradle.
- **Evidence-Driven:** Analysis distinguishes between positive semantic proof, transitive build bounds, and unverified assumptions.
- **Fail-Closed:** Missing or stale evidence triggers safe conservative expansion; incomplete verification never masquerades as success.
- **Deterministic:** Attestations use RFC 8785 Canonical JSON (JCS) and SHA-256 digests for cross-platform reproducibility.
- **Explicit Uncertainty:** Every impact and plan item declares its exact assurance level.
- **No False Verification:** Physical process execution truth is strictly distinguished from synthetic states or skipped obligations.

### Assurance Vocabulary

FDX categorizes confidence into four explicit assurance tiers:

| Tier | Meaning | Behavior |
| :--- | :--- | :--- |
| **`EXACT`** | Direct, deterministic positive evidence | Proven symbol dependency, exact-byte artifact match, or direct AST reference. |
| **`CONSERVATIVE`** | Safe bounding superset | Boundary widened to package or workspace when fine-grained dependency cannot be fully proven. |
| **`DEGRADED`** | Partial or stale evidence | Fallback rules applied due to outdated provider caches; verification bounds widened safely. |
| **`UNVERIFIED`** | Missing or unprovable evidence | Missing evidence fails closed; treated as unverified obligation requiring fallback checks. |

*Note: Assurance levels represent qualitative evidence classification, not probabilistic estimates.*

## Capabilities

| Area | Command | Purpose |
| :--- | :--- | :--- |
| **Repository Navigation** | `read`, `search`, `grep`, `ls`, `tree`, `diff`, `outline` | Token-optimized, AST-aware file reading and repository search. |
| **Semantic Intelligence** | `index`, `semantic` | Manage native EvidenceGraph index, SCIP references, and provider diagnostics. |
| **Change Intelligence** | `impact-v2`, `why` | Extract semantic diffs and compute verifiable transitive impact graphs. |
| **Build Intelligence** | `build` | Inspect package topology, dependencies, and build graph status. |
| **Verification Planning** | `plan` | Select evidence-backed verification obligations for code changes. |
| **Verification Execution** | `verify` | Run bounded, isolated verification processes with fail-fast options. |
| **Runtime History** | `history` | Query past verification runs, execution statistics, flake signals, and reconcile artifacts. |
| **Verification Attestations** | `attest` | Generate and verify deterministic in-toto Statement v1 attestations. |

## How It Works

```text
Repository Changes (Git Delta)
           │
           ▼
FDX Evidence Database (SQLite)
   ├── Semantic Evidence (tree-sitter / SCIP)
   ├── Build Evidence (Cargo, package.json)
   └── Runtime History (.fdx/runs/)
           │
           ▼
Transitive Impact Analysis (impact-v2)
           │
           ▼
Verification Planner (plan)
           │
           ▼
Bounded Verification Executor (verify)
           │
           ▼
Runtime History Ingestion (history)
           │
           ▼
Canonical Attestation Generation (attest)
```

1. **Evidence Gathering:** FDX extracts file diffs and parses ASTs or SCIP indexes to identify modified symbols and types.
2. **Impact Graph:** Build and semantic graphs combine to trace affected downstream symbols and packages.
3. **Deterministic Planning:** Impacted targets map to necessary verification checks (unit tests, lints, builds), rolling up obligations safely if bounds expand.
4. **Bounded Execution:** Checks execute in isolated process groups with strict timeouts, output caps, and stream capture.
5. **Historical Recording:** Execution results persist to durable `.fdx/runs/<run_id>.json` files and reconcile into SQLite for trend and flake analysis.
6. **Canonical Attestation:** Verification runs produce content-addressed, cryptographic in-toto statements formatted with canonical JSON.

## Installation

### From Source (Cargo)

FDX requires a standard Rust toolchain (Rust 1.80+ recommended).

```bash
# Build release binary
cargo build -p fdx --release

# Binary will be located at:
./target/release/fdx --version
```

To install the binary into your Cargo bin path (`~/.cargo/bin`):

```bash
cargo install --path crates/fdx
```

### Via FlowDeck Repository Tooling

When working inside the FlowDeck repository:

```bash
npm run build:fdx
```

## Quick Start

A complete verification lifecycle using FDX:

```bash
# 1. Initialize or check index status
fdx index status

# 2. Analyze transitive impact against base revision
fdx impact-v2 --base HEAD~1

# 3. Explain why a specific file or symbol is impacted
fdx why src/index.ts --base HEAD~1

# 4. Generate deterministic verification plan
fdx plan --base HEAD~1 --format json

# 5. Execute bounded verification checks
fdx verify --base HEAD~1 --fail-fast

# 6. Inspect recent verification runs in history
fdx history runs --limit 5

# 7. Create a canonical attestation for a verification run
fdx attest create --run <run-id>

# 8. Verify the attestation offline
fdx attest verify .fdx/attestations/<run_id>.<attestation_sha256>.json
```

## Command Reference

### Repository Navigation

- **`fdx read <FILE> [--mode <auto|raw|prototype|deep>] [--symbol <SYM>]`**: Read file content with token-conscious formatting.
- **`fdx search <PATTERN> [PATHS...]`**: Substring and AST symbol search with kind filtering (`function`, `struct`, `class`, `enum`, etc.).
- **`fdx grep <PATTERN> [PATHS...] [--context <N>]`**: Regex-enabled file content search with match limits.
- **`fdx ls [PATH] [-a]`**: Compact, token-optimized directory listing.
- **`fdx tree [PATH] [--depth <N>]`**: Gitignore-aware hierarchical directory tree.
- **`fdx diff [COMMIT] [--staged]`**: AST-aware git diff summary.
- **`fdx outline [PATHS...] [--depth <N>] [--kind <KINDS>]`**: High-level symbol outline across files.

### Semantic & Build Intelligence

- **`fdx index [ACTION] [--refresh]`**: Inspect index status (`fdx index status`) or force re-indexing.
- **`fdx semantic status`**: Inspect semantic provider health, freshness, fingerprints, and index scopes.
- **`fdx semantic refresh [--provider <ID>]`**: Refresh semantic provider indexes without external downloads.
- **`fdx semantic decode <FILE>`**: Parse and validate an SCIP index file.
- **`fdx semantic references <SYMBOL> [--lang <LANG>]`**: Query precise symbol references with explicit provenance.
- **`fdx build status`**: Display build provider status and topology metrics.
- **`fdx build refresh`**: Refresh build dependency graphs.
- **`fdx build graph`**: Export the complete multi-package build graph as JSON.

### Verifiable Change Intelligence

- **`fdx impact-v2 [--base <REF>] [--head <REF>] [--depth <N>]`**: Run verifiable change-impact analysis across Git revisions.
- **`fdx why <TARGET> [--base <REF>]`**: Display exact dependency path explaining why a target is impacted.
- **`fdx plan [--base <REF>] [--head <REF>]`**: Compute deterministic verification plan.
- **`fdx verify [--base <REF>] [--fail-fast] [--no-persist]`**: Execute verification plan checks with process containment.
- **`fdx history <COMMAND>`**: Query historical run evidence and flake signals.
- **`fdx attest <COMMAND>`**: Create and verify in-toto evidence attestations.

## Verifiable Change Intelligence

The core verification intelligence pipeline bridges code changes to verifiable truth:

### Change Intelligence
FDX extracts NUL-delimited diffs from Git, isolating modified ranges and matching them against AST nodes. It identifies whether changes touch function signatures, structs, types, or internal logic.

### Build Impact
Combining language-level ASTs with workspace build graphs (e.g. Cargo dependency trees, npm workspace topologies), FDX computes transitive dependency cones while pruning unaffected subtrees.

### Verification Planning
Impacted targets map to verification checks. If semantic precision is unavailable (e.g., dynamic imports or modified configuration files), FDX widens the obligation safely from specific test files to package or workspace-level suites.

### Verification Execution
Selected checks are executed in isolated, bounded sub-processes. FDX enforces per-check execution timeouts, process-group termination (preventing orphan processes), and output stream byte limits. Runs persist to `.fdx/runs/<run_id>.json`.

### Runtime History
Every execution is ingested into SQLite with exact artifact byte digests. FDX tracks check stability, duration trends, and flake signals across runs without allowing historical success to override future verification obligations.

### Verification Attestations
A completed verification run can be converted into a standalone, content-addressed in-toto Statement v1 attestation file stored in `.fdx/attestations/<run_id>.<attestation_sha256>.json`.

## Important Distinctions

- **Verification Obligation != Physical Process:** An obligation represents what must be proven. Some obligations may map to shared physical executions, while unsupported or skipped checks record zero physical executions.
- **Runtime Observation != Semantic Dependency:** Observing that two files executed in the same test does not establish a causal semantic link; runtime data informs stability, not static dependency proof.
- **Historical Success != Permission to Skip:** A check that passed previously is never skipped solely based on history; history provides flake detection and metrics, not a bypass for verification obligations.
- **Attestation != Digital Signature:** FDX attestations provide deterministic cryptographic content binding and artifact integrity. They are unsigned evidence statements and do not assert PKI identity or non-repudiation.

## Examples

### Historical Evidence Queries

```bash
# List the last 20 verification runs
fdx history runs --limit 20

# Show full details and check observations for a run
fdx history show 019184a2-7b3e-7b3c-9452-19e491c1d810

# Check execution statistics and flake score for a specific check
fdx history stats check-crates-fdx-test-attestation

# Identify entities frequently changed alongside a check
fdx history cooccurrences check-crates-fdx-test-attestation

# Reconcile all .fdx/runs/*.json files into the SQLite database
fdx history reconcile
```

### Creating and Verifying Attestations

```bash
# Create an attestation for a successful verification run
fdx attest create --run 019184a2-7b3e-7b3c-9452-19e491c1d810

# Output:
# Attestation created: .fdx/attestations/019184a2-7b3e-7b3c-9452-19e491c1d810.38a9d1c...8f.json
# Subject: fdx-verification-run:019184a2-7b3e-7b3c-9452-19e491c1d810
# SHA-256: 38a9d1c...8f

# Verify an attestation stored in .fdx/attestations/
fdx attest verify .fdx/attestations/019184a2-7b3e-7b3c-9452-19e491c1d810.38a9d1c...8f.json

# Verify an external attestation with expected digest
fdx attest verify /tmp/external-attestation.json --expected-sha256 38a9d1c...8f

# Inspect attestation contents
fdx attest show .fdx/attestations/019184a2-7b3e-7b3c-9452-19e491c1d810.38a9d1c...8f.json

# List all managed attestations
fdx attest list
```

### Attestation Specifications

- **Envelope:** [in-toto Statement v1](https://in-toto.io/Statement/v1) (`_type: "https://in-toto.io/Statement/v1"`)
- **Predicate:** FlowDeck Verification Predicate v1 (`predicateType: "https://flowdeck.dev/attestation/vci/verification/v1"`)
- **Canonicalization:** RFC 8785 JSON Canonicalization Scheme (JCS)
- **Subject Identity:** Subject named `fdx-verification-run:<run_id>` with `digest.sha256` computed over exact raw persisted M7 run artifact (`.fdx/runs/<run_id>.json`) bytes
- **Offline:** 100% self-contained offline verification; no network access required

*FDX attestations currently provide evidence integrity and binding. They do not provide signer identity, non-repudiation, PKI, Sigstore, or transparency-log inclusion.*

## Performance

The following benchmarks are measured using dedicated qualification harnesses on standard Linux x86_64 environments running Node v24.19.0 and native release builds.

### Qualification Measurements

| Operation | Target / Dataset | Median Latency | Qualification Reference |
| :--- | :--- | ---: | :--- |
| **Index Status (Warm)** | EvidenceGraph SQLite | 19.82 ms | M2 Benchmark |
| **Semantic Refresh** | SCIP Provider Sync | 21.12 ms | M3 Benchmark |
| **SCIP Decode** | Symbol Index (484 B fixture) | 3.09 ms | M3 Benchmark |
| **Git Change Extraction** | NUL-delimited tree diff | 2.03 ms | M4 Benchmark |
| **Transitive Impact** | Fresh SCIP Provider graph | 27.90 ms | M4 Benchmark |
| **Build Graph Impact** | Workspace build dependencies | 87.03 ms | M5 Benchmark |
| **Verification Plan** | Precise semantic test mapping | 20.81 ms | M6 Benchmark |
| **Verification Plan** | Build transitive test mapping | 42.92 ms | M6 Benchmark |
| **Single Package Verify** | Bounded check execution | 118.94 ms | M7 Benchmark |
| **History Query** | 50 historical runs query | 3.18 ms | M8 Benchmark |
| **History Stats Query** | Flake / duration aggregation | 3.05 ms | M8 Benchmark |
| **History Reconcile** | 50 run artifacts sync | 7.12 ms | M8 Benchmark |
| **Attestation Create** | Single qualified run | 5.49 ms | M9 Benchmark (R28) |
| **Attestation Verify** | Single qualified attestation | 4.99 ms | M9 Benchmark (R28) |

### Bulk Throughput (M9 Qualified)

- **100 Attestation Creates:** 554.21 ms total (~5.54 ms / run)
- **100 Attestation Verifies:** 605.48 ms total (~6.05 ms / run)

*These are benchmark measurements from the qualification environment, not universal performance guarantees. Repository size, storage, platform, selected checks, process startup, and toolchain behavior affect real-world results.*

## Safety and Trust Model

FDX enforces strict trust boundaries:

- **Missing Evidence Never Means No Impact:** When AST or SCIP evidence is absent, FDX widens scope conservatively rather than assuming zero impact.
- **Stale Evidence Never Becomes Negative Evidence:** Expired indexes cannot be used to prove the absence of dependencies.
- **Unsupported Capabilities Fail Closed:** If a platform or check type cannot guarantee safe containment, execution halts with an explicit error.
- **Bounded Execution & Output:** Process execution is bounded by wall-clock timeouts and byte limits (default 16 MiB reader limit) to prevent resource exhaustion.
- **Explicit Unresolved Obligations:** Skipped, failed, or unsupported checks remain visible in verification outcomes.
- **Exact-Byte Artifact Identity:** Persisted run artifacts and attestations require bit-for-bit SHA-256 identity matches.
- **No Planner Promotion from History:** Historical test success cannot remove obligations from future verification plans.
- **Attestations Create No New Verification Truth:** Attestations cryptographically bind existing verification run artifacts; they cannot validate an invalid run.

## Platform Support

- **Linux (x86_64, aarch64):** Full support. Native process grouping (`setpgid`, `killpg`), descriptor-relative filesystem operations (`rustix` / `openat`, `NOFOLLOW`), and SQLite concurrency.
- **macOS (Apple Silicon, Intel):** Full support. POSIX process isolation and descriptor-relative filesystem operations supported.
- **Windows:** Bounded/Partial support. Verification execution that requires POSIX process-tree containment fails closed safely if containment guarantees cannot be met.

## Development

Prerequisites: Rust 1.80+, Bun / Node.js.

```bash
# Format check
cargo fmt --all --check

# Strict linting
cargo clippy -p fdx --all-targets --all-features -- -D warnings

# Run all unit and integration tests
cargo test -p fdx
```

## Testing

When developing inside the FlowDeck workspace, ensure full parity and contract validation pass:

```bash
# Run FDX contract tests
bun test tests/fdx-vci-contracts.test.ts

# Run parity verification
npm run test:fdx-parity

# Run pre-push gate
npm run verify:fast
```

## Architecture

```text
                  ┌─────────────────────────────────┐
                  │          Repository             │
                  └────────────────┬────────────────┘
                                   │
                                   ▼
                  ┌─────────────────────────────────┐
                  │     FDX Index / Evidence DB     │
                  │             (SQLite)            │
                  └──────┬──────────────────┬───────┘
                         │                  │
               Semantic Evidence       Build Evidence
                 (tree-sitter)         (Cargo / npm)
                         │                  │
                         ▼                  ▼
                  ┌─────────────────────────────────┐
                  │    Change & Impact Analysis     │
                  └────────────────┬────────────────┘
                                   │
                                   ▼
                  ┌─────────────────────────────────┐
                  │      Verification Planner       │
                  └────────────────┬────────────────┘
                                   │
                                   ▼
                  ┌─────────────────────────────────┐
                  │      Verification Executor      │
                  └────────────────┬────────────────┘
                                   │
                           Run Artifacts (.json)
                                   │
                                   ▼
                  ┌─────────────────────────────────┐
                  │   Runtime History & Ingestion   │
                  └────────────────┬────────────────┘
                                   │
                                   ▼
                  ┌─────────────────────────────────┐
                  │    Verification Attestation     │
                  │       (in-toto / JCS)           │
                  └─────────────────────────────────┘
```

- **Evidence DB:** SQLite stores symbol outlines, file hashes, build provider graphs, and ingested runtime executions.
- **Artifact Store:** Persisted `.fdx/runs/<run_id>.json` files act as durable source-of-truth evidence artifacts independent of database state.
- **Attestation Store:** `.fdx/attestations/<run_id>.<attestation_sha256>.json` holds immutable, content-addressed verification statements.

## Limitations

- **Unsigned Attestations:** Attestations establish cryptographic binding and content integrity locally; they do not include digital signatures, PKI certs, or Sigstore transparency logs.
- **Semantic Provider Dependencies:** Full semantic precision requires SCIP indexing tools (e.g. `rust-analyzer`, `scip-typescript`); in their absence, FDX falls back to syntactic tree-sitter analysis.
- **POSIX Process Tree Reliance:** Hard timeout termination relies on process groups (`killpg`), which may leave background sub-processes on platforms lacking POSIX process containment.

## License

This project is licensed under the [MIT License](../../LICENSE).
