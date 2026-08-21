# FDX VCI Compatibility Matrix & Versioning Contract

## 1. Versioning Dimensions

FDX Verifiable Change Intelligence decouples its internal and external contracts into four independent version spaces.

| Version Dimension | Current Value | Scope | Breaking Invalidation Behavior |
|---|---|---|---|
| **`FDX_PROTOCOL_VERSION`** | `2` | JSON-lines IPC protocol between daemon and clients | Requires daemon process restart / re-negotiation |
| **`FDX_GRAPH_SCHEMA_VERSION`** | `1` | Relational layout in `.fdx/index.sqlite` | Triggers SQLite migration or index rebuild |
| **`FDX_SELECTION_POLICY_VERSION`** | `1` | Escalation heuristics and test planner algorithms | Invalidates cached verification plans |
| **`FDX_ATTESTATION_PREDICATE_VERSION`** | `1` | in-toto-compatible attestation structure | Re-evaluates attestation verification status |

---

## 2. Protocol Capability Negotiation

Clients and daemons negotiate protocol capabilities on startup or on demand.

### 2.1 Capability Identifier Registry

| Capability ID | Minimum Protocol | Description | Fallback Behavior |
|---|---|---|---|
| `search` | 1 | Token-optimized symbol search | Basic grep |
| `outline` | 1 | AST outline extraction | Line-based chunking |
| `read` | 1 | Token-optimized reading | File system read |
| `impact-v1` | 1 | Direct AST-based impact analysis | In-memory TS impact |
| `impact-v2` | 2 | Transitive EvidenceGraph impact | `impact-v1` AST analysis |
| `evidence-graph-v1`| 2 | SQLite EvidenceGraph query & traversal | File-based dependency scan |
| `vci-v1` | 2 | Verifiable Change Intelligence & Planner | Full test run |
| `why-v1` | 2 | Provenance explanation (`fdx why`) | Degraded explanation |

### 2.2 Wire Protocol Handshake

```json
// Request
{
  "id": "req-1",
  "op": "negotiate",
  "args": {
    "protocol": 2,
    "capabilities": ["search", "outline", "impact-v1", "vci-v1"]
  }
}

// Response
{
  "id": "req-1",
  "ok": true,
  "value": {
    "protocol": 2,
    "selected_capabilities": ["search", "outline", "impact-v1", "vci-v1"],
    "server_capabilities": ["search", "outline", "read", "impact-v1", "impact-v2", "evidence-graph-v1", "vci-v1", "why-v1"],
    "graph_schema_version": 1,
    "selection_policy_version": 1,
    "attestation_predicate_version": 1
  }
}
```

---

## 3. Backward Compatibility Invariants

1. **Protocol 1 Clients**: Unrecognized ops in older clients (e.g. `version`, `read`, `search`, `outline`, `impact`) continue to work identically without requiring capability negotiation.
2. **Schema Upgrades**: Upgrading `FDX_GRAPH_SCHEMA_VERSION` does not change the wire protocol format.
3. **Policy Updates**: Updating `FDX_SELECTION_POLICY_VERSION` does not force re-indexing of semantic nodes and edges in SQLite.
4. **Daemon Downgrade**: If a client requires Protocol 2 features and connects to a Protocol 1 daemon, the client falls back to one-shot native invocations or TypeScript fallback.
