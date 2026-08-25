# FDX VCI Compatibility Matrix & Versioning Contract

## 1. Final Versioning and Capability Contract

FDX Verifiable Change Intelligence maintains independent protocol, persistence, planning, attestation, calibration, policy, and capability authorities. The values below are the final frozen M12 contract and must agree with the locally emitted `fdx capabilities --format json` document.

| Version Dimension | Final Value | Scope | Compatibility and safety behavior |
|---|---:|---|---|
| **`FDX_PROTOCOL_VERSION`** | `2` | JSON-lines IPC protocol between daemon and clients | Requires daemon re-negotiation when protocol support differs. |
| **`FDX_GRAPH_SCHEMA_VERSION`** | `10` | Relational layout in `.fdx/index.sqlite` | Reads schemas from v1; writes only through v10. Future schemas fail closed before mutation. |
| **`FDX_SELECTION_POLICY_VERSION`** | `1` | Escalation and verification-planner policy | Invalidates plan caches without changing semantic evidence. |
| **Default attestation predicate** | `v1` | Frozen in-toto Statement v1 predicate | Existing create behavior stays v1; strict v1 canonicalization, URI, and field rejection remain unchanged. |
| **Supported attestation predicates** | `v1`, `v2` | Verification attestation evidence | v2 is explicit and content-binds historical M11 policy application provenance. Unknown predicate URIs fail closed. |
| **Capability contract** | `1` | Deterministic local compatibility authority | Unknown contract versions are not authority-bearing. The document reports no network access and no telemetry. |
| **Calibration contract** | `2` | M10 shadow-calibration evidence | Measurement-only; calibration cannot change M6 planning, assurance, or active policy state. |
| **Policy contract** | `1` | M11 learned-policy overlay | Explicit `ADD_CHECK` only; it can widen an impacted plan but cannot remove base checks, upgrade assurance, or remove unresolved obligations. |

The local capabilities document reports graph schema minimum readable `1`, maximum writable `10`, and `can_read`, `can_write`, and `can_verify` semantics. It reports compiled local SCIP and Tree-sitter state, local native-process execution limitations, the current platform, and exact supported predicate, calibration, and policy contract lists.

---

## 2. Protocol Capability Negotiation

Clients and daemons negotiate protocol capabilities on startup or on demand. The negotiation response retains its legacy v1-default attestation field for compatibility and adds M12 capability metadata without removing any prior field.

### 2.1 Capability Identifier Registry

| Capability ID | Minimum Protocol | Description | Fallback Behavior |
|---|---:|---|---|
| `search` | 1 | Token-optimized symbol search | Basic grep |
| `outline` | 1 | AST outline extraction | Line-based chunking |
| `read` | 1 | Token-optimized reading | File system read |
| `impact-v1` | 1 | Direct AST-based impact analysis | In-memory TypeScript impact |
| `impact-v2` | 2 | Transitive EvidenceGraph impact | `impact-v1` AST analysis |
| `evidence-graph-v1` | 2 | SQLite EvidenceGraph query and traversal | File-based dependency scan |
| `semantic-status-v1` | 2 | Semantic-provider status | Degraded local status |
| `why-v1` | 2 | Provenance explanation (`fdx why`) | Degraded explanation |

### 2.2 Wire Protocol Handshake

```json
// Request
{
  "id": "req-1",
  "op": "negotiate",
  "args": {
    "protocol": 2,
    "capabilities": ["search", "outline", "impact-v1", "impact-v2"]
  }
}

// Response
{
  "id": "req-1",
  "ok": true,
  "value": {
    "protocol": 2,
    "selected_capabilities": ["search", "outline", "impact-v1", "impact-v2"],
    "server_capabilities": [
      "read",
      "search",
      "outline",
      "impact-v1",
      "evidence-graph-v1",
      "semantic-status-v1",
      "impact-v2",
      "why-v1"
    ],
    "graph_schema_version": 10,
    "selection_policy_version": 1,
    "attestation_predicate_version": 1,
    "capability_contract_version": 1,
    "attestation_predicate_versions": [1, 2],
    "calibration_contract_versions": [2],
    "policy_contract_versions": [1]
  }
}
```

---

## 3. Backward Compatibility Invariants

1. **Protocol clients** retain the legacy protocol-version, graph-schema, selection-policy, and default Predicate v1 fields. The supported predicate, calibration, policy, and capability-contract lists are additive.
2. **Schema upgrades** do not change the wire protocol. A supported older schema may migrate through v10; a future schema must never be silently written by this binary.
3. **Predicate v1** remains the default create path and strict content-bound verification format. Predicate v2 is selected explicitly and is never silently substituted for v1.
4. **Policy updates** remain independent of M6 planning authority. Only explicitly promoted M11 `ADD_CHECK` policy can add checks; calibration is measurement-only and policy-selected observations cannot self-reinforce promotion support.
5. **Local operation** is deterministic and offline. Capability negotiation, planning, verification, attestation, calibration, policy queries, and persisted evidence do not require a network service or telemetry.

## References

[1] [Canonical protocol constants and negotiation response](../../crates/fdx/src/protocol.rs)

[2] [Canonical local capabilities contract](../../crates/fdx/src/intelligence/capabilities.rs)

[3] [Final M12 architecture and compatibility guide](./fdx-m12-verifiable-change-intelligence.md)
