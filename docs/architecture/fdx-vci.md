# FDX VCI — Verifiable Change Intelligence Architecture Specification

## 1. Executive Summary

**FDX Verifiable Change Intelligence (VCI)** is the evidence-grounded dependency, impact, and verification engine for FlowDeck. It provides deterministic, provable intelligence about code changes, affected dependencies, and the exact verification checks required to guarantee correctness.

Unlike heuristic or speculative code graphs, FDX VCI operates on an explicit **Evidence and Assurance Model**:
1. Every semantic edge is backed by verifiable provenance (SCIP, Tree-sitter, compiler artifacts, build configs, or runtime observations).
2. Unknown relationships (dynamic imports, eval, reflection, config changes) are modeled as explicit `Uncertainty` triggers with compile-time-enforced escalation policies.
3. Verification planning generates provably sufficient verification sets with cryptographic/content-hash attestations.

---

## 2. Core Architecture Pipeline

```
OpenCode / Heidi Agents
      │
      ▼
FDX Tool Surface (TypeScript / CLI)
      │
      ▼
FdxTurboEngine (Cache & Invalidation Router)
      │
      ▼
Resident Native `fdx serve` (Daemon)
      │
      ▼
EvidenceGraph (Embedded SQLite: .fdx/index.sqlite)
      ├─ SCIP / Compiler Evidence (Precise)
      ├─ Tree-sitter Structural Evidence (Structural)
      ├─ Build / Config Evidence (Observed / Config)
      ├─ Test / Runtime Evidence (Observed)
      └─ Historical / Calibration Evidence (Historical)
      │
      ▼
Verification Planner
      │
      ▼
`fdx verify --changed` (Targeted Execution)
      │
      ▼
Verification Attestation (in-toto-compatible Statement)
      │
      ▼
Shadow Calibration (Measurement & Feedback Governor)
```

---

## 3. Fallback and Routing Hierarchy

FDX strictly enforces the following tier-ordered resolution model:

1. **Resident Native Daemon (`fdx serve`)**: High-performance persistent IPC daemon over stdin/stdout with bounded worker pool and sub-millisecond query responses.
2. **Native Persistent Intelligence (Embedded Native SQLite)**: On-disk SQLite database (`.fdx/index.sqlite`) providing indexed graph traversals.
3. **One-shot Native FDX Binary**: Single-invocation binary fallback when daemon is restarting or unavailable.
4. **TypeScript Compatibility Fallback**: In-memory TypeScript index preserving legacy support until full native parity is proven.

*Invariant*: No separate permanent TypeScript graph is maintained beside the native EvidenceGraph. The TypeScript fallback is strictly an in-memory compatibility bridge.

---

## 4. Evidence Model & Provenance

### 4.1 Evidence Strength Hierarchy

Semantic certainty is classified into five discrete tiers:

```rust
pub enum EvidenceStrength {
    /// Compiler-verified or SCIP symbol-precise reference.
    Precise,
    /// Build output, test runner execution, or runtime observed trace.
    Observed,
    /// Tree-sitter AST structure (import statement, class definition, etc.).
    Structural,
    /// Name-based, path-based, or convention-based association.
    Heuristic,
    /// Explicitly unknown or unresolved relationship.
    Unknown,
}
```

### 4.2 Evidence Providers

```rust
pub enum EvidenceProviderKind {
    SCIP,
    CompilerNative,
    TreeSitter,
    BuildNative,
    RunnerNative,
    RuntimeObserved,
    Historical,
    ManualRule,
}
```

### 4.3 Provenance Metadata

Every edge in the EvidenceGraph records:
- `provider`: Provider kind.
- `provider_fingerprint`: Version and config fingerprint of the producing provider.
- `strength`: `EvidenceStrength`.
- `source_identity`: Unique symbol/path identity of the source.
- `source_hash`: Content SHA-256 of the source artifact at analysis time.
- `freshness`: Timestamp, mtime, and staleness indicator.

*Invariant*: Missing or uncertain information is NEVER silently omitted as "no dependency". It is recorded as `EvidenceStrength::Unknown` with an associated `Uncertainty` trigger.

---

## 5. Assurance Levels & Assurance Ceiling

### 5.1 Assurance Levels

```rust
pub enum AssuranceLevel {
    /// 100% precise symbol-level evidence covering all changes.
    Exact,
    /// Safely escalated containment boundary covering all uncertainties.
    Conservative,
    /// Fallback or degraded evidence provider; verification expanded.
    Degraded,
    /// Insufficient evidence to construct a verifiable safety boundary.
    Unverified,
}
```

### 5.2 Assurance Ceiling

The **Assurance Ceiling** represents the maximum assurance level the current repository state and available tools can achieve:
- If SCIP indexers are missing and only Tree-sitter is available $\rightarrow$ Assurance Ceiling is `Conservative`.
- If dynamic runtime plugins or `eval` are detected in modified scopes $\rightarrow$ Assurance Ceiling degrades to `Conservative` with package/workspace escalation.
- If unindexed file types or corrupted databases are present $\rightarrow$ Assurance Ceiling is `Degraded` or `Unverified`.

---

## 6. Uncertainty Modeling & Escalation Policies

Uncertainty is centralized in an exhaustive Rust enum:

```rust
pub enum UnknownTrigger {
    DynamicImport,
    Reflection,
    Eval,
    RuntimePluginLoading,
    DependencyInjection,
    LockfileChange,
    BuildConfigChange,
    CompilerConfigChange,
    SchemaChange,
    GeneratedArtifactChange,
    UnsupportedLanguage,
    StaleSemanticProvider,
    ProviderMismatch,
    ExternalContractChange,
    TestOrderDependency,
}
```

### 6.1 Containment Scopes & Escalation Mapping

Escalation expands verification to the smallest boundary known to contain the unresolved effect:

| Unknown Trigger | Default Escalation Scope | Risk Severity |
|---|---|---|
| `DynamicImport` | `Package` | Medium |
| `Reflection` | `Package` | High |
| `Eval` | `Package` | Critical |
| `RuntimePluginLoading` | `Workspace` | High |
| `DependencyInjection` | `DependentPackages` | Medium |
| `LockfileChange` | `FullTestSuite` | High |
| `BuildConfigChange` | `Workspace` | High |
| `CompilerConfigChange` | `FullVerification` | Critical |
| `SchemaChange` | `DependentPackages` | High |
| `GeneratedArtifactChange` | `DependentPackages` | Medium |
| `UnsupportedLanguage` | `Package` | Medium |
| `StaleSemanticProvider` | `DependentPackages` | Medium |
| `ProviderMismatch` | `DependentPackages` | Low |
| `ExternalContractChange` | `Workspace` | High |
| `TestOrderDependency` | `FullTestSuite` | High |

*Invariant*: The compiler exhaustively enforces that every `UnknownTrigger` has an explicit escalation mapping.

---

## 7. Versioning & Compatibility Contracts

The system decouples versioning across four independent dimensions:

1. **`FDX_PROTOCOL_VERSION`** (Current: `2`): Wire format between client/tools and daemon.
2. **`FDX_GRAPH_SCHEMA_VERSION`** (Current: `1`): Physical SQLite relational schema.
3. **`FDX_SELECTION_POLICY_VERSION`** (Current: `1`): Verification selection and escalation heuristics.
4. **`FDX_ATTESTATION_PREDICATE_VERSION`** (Current: `1`): Attestation cryptographic signature format.

A selection policy update invalidates cached plans without requiring re-indexing. A schema update triggers an in-place SQLite migration without changing the wire protocol.

---

## 8. Query Routing Intents

The IPC protocol supports fine-grained query intents:

- **`LOCALIZE`**: Fast lexical and outline search for initial symbol locating.
- **`REFERENCE_COMPLETE`**: SCIP-driven exhaustive reference resolution.
- **`IMPACT`**: Transitive dependency traversal across the EvidenceGraph.
- **`RENAME`**: Union of precise SCIP references and lexical safety checks.
- **`CONTEXT`**: Token-budgeted minimal subgraph extraction for LLM prompt injection.

---

## 9. Path Canonicalization & Security Jail

All paths across the protocol and EvidenceGraph adhere to strict canonicalization:
- Repository-relative (no absolute paths).
- Forward slash (`/`) normalization across Linux, macOS, and Windows.
- Stripped `.` and `..` path components.
- No drive-letter prefixes (`C:`).
- Enforced workspace root jail: symlinks resolving outside the repository root are rejected.
