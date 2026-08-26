# FDX Intelligent MCP Server

## Purpose

`fdx mcp` exposes FlowDeck’s local, evidence-aware FDX capabilities as a native **Model Context Protocol (MCP)** server. It gives a coding client repository-scoped code intelligence, semantic evidence, change impact, verification planning and execution, runtime evidence, attestation, calibration, and verification-policy governance.

The server is implemented **inside the FDX binary**. It translates closed MCP tool schemas into allowlisted FDX argument vectors; it does not expose a terminal, arbitrary command arguments, arbitrary filesystem roots, or network access. FDX remains the source of truth for its evidence, assurance, freshness, uncertainty, and capability contracts.

> **Transport choice matters.** `fdx mcp` is a local stdio server for generic MCP clients. Direct ChatGPT Developer Mode use requires the remote streaming-HTTP endpoint described below, deployed behind TLS and an OAuth-aware reverse proxy. ChatGPT currently connects developer-mode apps to remote SSE or streaming-HTTP MCP servers, not directly to a local stdio process.[1]

## Start a local stdio server

For local MCP clients that launch a subprocess, run one FDX server per authorized repository:

```sh
cargo run -p fdx -- mcp --root /absolute/path/to/allowed-repository
```

The stdio transport uses newline-delimited JSON-RPC. Standard output is reserved exclusively for MCP messages; diagnostics are written to standard error.

## Deploy for ChatGPT Developer Mode

The FDX remote endpoint is intentionally **loopback-only** and requires a bearer capability. It must be placed behind a TLS/OAuth reverse proxy that validates the ChatGPT user, authorizes the repository, and injects the private local bearer token before forwarding to FDX.

```sh
export FDX_MCP_BEARER_TOKEN="use-a-random-secret-of-at-least-16-characters"

cargo run -p fdx -- mcp http \
  --root /absolute/path/to/allowed-repository \
  --listen 127.0.0.1:8787 \
  --token-env FDX_MCP_BEARER_TOKEN \
  --allow-origin https://chatgpt.com
```

The endpoint is `POST /mcp`. It supports the current MCP `2025-06-18` protocol and the two specified prior versions. It creates a cryptographically random `Mcp-Session-Id` at initialization, requires that session identifier on subsequent requests, limits session lifetime, and returns ordinary JSON responses for streaming-HTTP requests.

| Deployment component | Required responsibility |
|---|---|
| FDX server | Bind only to `127.0.0.1` or `::1`, enforce its private bearer token, enforce repository scope, and never serve TLS directly. |
| TLS/OAuth reverse proxy | Terminate HTTPS, validate OAuth tokens from ChatGPT, enforce application and repository authorization, rate-limit traffic, and replace or inject the local FDX bearer token. |
| Public MCP URL | Expose only `https://your-domain.example/mcp`; never expose FDX’s loopback port directly. |
| ChatGPT app configuration | In ChatGPT Developer Mode, create a remote MCP app for the public HTTPS endpoint and configure OAuth at the reverse proxy. Review each write or execution tool call. |

A static FDX bearer token is deliberately **not** a substitute for public authentication. Do not put it in a browser, ChatGPT connector configuration, source control, logs, or URL. The proxy must keep that local token private and issue it only when forwarding an authenticated, authorized request to loopback.

## Tool catalog

The server publishes eighteen purpose-built MCP tools. Tool schemas are closed (`additionalProperties: false`), bounded, and described for coding-agent selection. All source and artifact paths are repository-relative and passed through FDX’s containment guard.

| Tool | Primary FDX capability | Safety classification |
|---|---|---|
| `fdx_intelligence_status` | Capability, index, semantic-provider, and build-provider state. | Read-only |
| `fdx_code_read` | Token-optimized, symbol-aware file reading. | Read-only |
| `fdx_code_search` | Language-aware symbol search. | Read-only |
| `fdx_code_outline` | Structured cross-file symbol inventory. | Read-only |
| `fdx_code_grep` | Bounded literal or regular-expression textual search. | Read-only |
| `fdx_workspace_structure` | Compact directory list or gitignore-aware tree. | Read-only |
| `fdx_code_diff` | Symbol-aware Git diff with safe base refs and constrained paths. | Read-only |
| `fdx_semantic_decode` | Bounded SCIP index statistics. | Read-only |
| `fdx_semantic_references` | Semantic references with provenance, freshness, and completeness. | Read-only |
| `fdx_build_graph` | Local build/configuration graph. | Read-only |
| `fdx_change_analysis` | Transitive impact, impact explanation, and deterministic verification planning. | Read-only |
| `fdx_verification` | Verification plan or bounded local check execution. | Executes local checks |
| `fdx_intelligence_history` | Historical verification runs and check statistics; reconciliation can update local history. | Mixed local state |
| `fdx_attestation` | Attestation inspection, verification, and local artifact creation. | Mixed local state |
| `fdx_calibration` | Calibration inspection or bounded shadow verification runs. | Executes local checks |
| `fdx_verification_policy` | Candidate, active, promotion, and revocation workflows. | Mixed local state |
| `fdx_provider_refresh` | Semantic or build-provider local discovery. | Local cache refresh |
| `fdx_index_management` | EvidenceGraph status or local refresh. | Mixed local state |

## Safety model

The MCP annotations communicate a tool’s risk to ChatGPT, but client annotations are never the complete security boundary. Deployment authorization remains at the reverse proxy and FDX server process boundary.

| Control | Enforcement |
|---|---|
| Repository confinement | FDX starts with one canonical root. Existing FDX containment checks reject absolute escapes, `..` traversal, symlink escapes, unsafe ancestors, UNC paths, and NUL bytes. |
| Closed input contract | MCP input schemas reject unknown fields in capable clients. The server independently type-checks, bounds, and enum-validates each accepted input before constructing an FDX argv vector. |
| Shell-injection prevention | The adapter starts FDX with `std::process::Command` and prevalidated positional arguments. It never invokes a shell. Git refs, symbol targets, IDs, and paths use separate conservative validation. |
| Lifecycle and compatibility | Tools are unavailable until `initialize` succeeds and the client sends `notifications/initialized`. Unsupported protocol versions receive a JSON-RPC error rather than a misleading success response. |
| Bounded execution | FDX child commands receive a wall-clock timeout. Verification and calibration have a longer but finite execution allowance. Standard input is closed for child commands. |
| Bounded process output | Standard output and standard error are consumed concurrently, capped while reading, decoded safely, and marked as truncated when limits apply. |
| Remote transport containment | The HTTP listener accepts bearer-authenticated traffic only, binds only to loopback, enforces session IDs and expiration, validates allowlisted browser origins, caps HTTP header/body size, times out reads, and bounds concurrent connections. |
| Explicit user control | Tools that execute checks or can persist history, policies, indexes, attestations, or provider state are not read-only. ChatGPT Developer Mode will request confirmation for tools without a read-only hint.[1] |

## Recommended coding workflow

Begin each task with `fdx_intelligence_status`. Use the read, search, outline, grep, structure, diff, semantic-reference, build-graph, and change-analysis tools to understand the repository. Treat FDX uncertainty, provider staleness, unsupported languages, and incomplete semantic evidence as limits on confidence rather than proof of safety.

Before executing validation, call `fdx_verification` with `action: "plan"`. After the user requests validation and the proposed plan is appropriate, use `action: "verify"`. Verification is non-persistent unless the caller explicitly provides `persist: true`.

Attestation creation, calibration runs, index refresh, history reconciliation, policy promotion, and policy revocation are deliberate state-changing follow-up actions. The user should be told exactly what state will change before the tool is invoked.

## Validation

Run the following from the FlowDeck workspace:

```sh
cargo fmt --all --check
cargo clippy -p fdx --all-targets -- -D warnings
cargo test -p fdx
```

For streaming-HTTP validation, start the loopback endpoint with a temporary token, then verify the following sequence: authenticated `initialize` returns a session ID; `notifications/initialized` returns `202`; `tools/list` returns the full catalog; missing credentials return `401`; and a non-allowlisted `Origin` returns `403`.

## References

[1]: https://developers.openai.com/api/docs/guides/developer-mode "OpenAI: ChatGPT Developer mode"
[2]: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports "Model Context Protocol: Transports"
[3]: https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle "Model Context Protocol: Lifecycle"
[4]: https://modelcontextprotocol.io/specification/2025-06-18/server/tools "Model Context Protocol: Tools"
