# Second Adversarial Audit: FDX Intelligent MCP for ChatGPT

**Audited branch:** `feat/heidi-fdx-chatgpt-intelligence`  
**Baseline:** `de9225ff`  
**Audit date:** 2026-08-26  
**Scope:** Native FDX MCP protocol behavior, direct ChatGPT compatibility, repository confinement, execution controls, output handling, tool coverage, and regression safety.

## Executive conclusion

The original local stdio MCP implementation was a sound foundation for generic local MCP clients, but it was **not sufficient for direct ChatGPT Developer Mode use**. The second audit identified and corrected that material compatibility gap, along with lifecycle, version-negotiation, process-boundary, output-handling, and capability-coverage issues.

The corrected implementation now provides both a local stdio transport and a **loopback-only streaming-HTTP MCP endpoint** appropriate for placement behind a TLS/OAuth reverse proxy. The server publishes eighteen repository-scoped FDX tools, enforces the MCP lifecycle before tool use, negotiates supported protocol versions, bounds child process duration and captured output, and constrains remote sessions and HTTP request handling.

> **Deployment conclusion:** The FDX binary is ready to serve a ChatGPT-compatible remote MCP endpoint **behind an authenticated HTTPS reverse proxy**. It intentionally does not expose TLS, OAuth validation, or a public network listener itself. Those responsibilities must remain at the deployment edge.

## Findings and remediation

| ID | Severity before remediation | Finding | Resolution | Final status |
|---|---:|---|---|---|
| MCP-01 | Critical | Stdio-only transport could not be connected directly as a remote ChatGPT app. | Added `fdx mcp http`, a streaming-HTTP `POST /mcp` endpoint for use behind TLS and OAuth-aware proxy infrastructure. The listener rejects non-loopback binds. | Resolved in binary; proxy deployment remains required. |
| MCP-02 | High | Protocol version was hard-coded to `2024-11-05` without inspecting client input. | Added explicit negotiation for `2025-06-18`, `2025-03-26`, and `2024-11-05`; unsupported versions receive JSON-RPC `-32602`. | Resolved. |
| MCP-03 | High | Tools could be invoked before `notifications/initialized`. | Added per-connection lifecycle state. Tools are rejected with `-32002` until initialization completes. | Resolved. |
| MCP-04 | High | Child FDX invocations had no adapter-level deadline. | Added operation-aware wall-clock timeouts, closed child stdin, concurrent pipe draining, and termination on timeout. | Resolved. |
| MCP-05 | Medium | Output truncation sliced UTF-8 strings by byte offset and could panic. | Replaced byte-index slicing with bounded byte capture followed by lossless UTF-8 decoding and explicit truncation metadata. | Resolved. |
| MCP-06 | Medium | Child output was captured in full before result bounding. | Captures stdout and stderr incrementally with a fixed safety cap while draining both streams concurrently. | Resolved. |
| MCP-07 | Medium | Catalog omitted several bounded FDX intelligence and code-understanding workflows. | Expanded from 12 to 18 tools, adding grep, workspace structure, symbol-aware diff, SCIP decode, index management, and build graph. | Resolved. |
| MCP-08 | Low | Tool selection metadata was thin. | Added action-oriented descriptions and parameter descriptions for the new high-disambiguation tools; strengthened server instructions. | Substantially improved; future product iteration may add stable output schemas per tool. |
| MCP-09 | High | A remote listener could grow unbounded connection work. | Added bounded concurrent connection admission, header/body limits, request read timeout, session expiration, per-session locking, and constant-time bearer comparison. | Resolved. |

## Security boundary verified

| Boundary | Observed control |
|---|---|
| Filesystem | Each process uses one canonical repository root. FDX containment resolution rejects parent traversal, absolute escapes, unsafe ancestors, symlink escapes, UNC paths, and NUL bytes. |
| Command execution | The MCP server only builds allowlisted FDX argv vectors and invokes them with `std::process::Command`; it never executes shell text. |
| Git arguments | Git refs are separately allowlisted. An adversarial `HEAD;rm -rf /` input was rejected before process invocation. |
| Runtime workload | Tool output is bounded, FDX commands have deadlines, and verification/calibration have finite execution allowances. |
| HTTP endpoint | Remote transport accepts authenticated requests only, binds to loopback only, maintains unguessable session IDs, validates allowlisted `Origin` values when supplied, and does not directly expose a public port. |
| Mutating operations | Verification execution, calibration, provider/index refresh, history reconciliation, attestation creation, and policy mutation are not marked read-only. Verification defaults to no persisted artifact. |

## Validation evidence

| Validation | Result |
|---|---|
| `cargo fmt --all --check` | Passed. |
| `cargo clippy -p fdx --all-targets -- -D warnings` | Passed. |
| `cargo test -p fdx` | Passed, including all FDX unit, integration, and doc tests. |
| Stdio MCP lifecycle smoke test | Passed: `initialize` → `notifications/initialized` → guarded tool invocation. |
| Lifecycle adversarial test | Passed: pre-initialization tool requests are rejected; unknown protocol versions are rejected. |
| Repository-escape probe | Passed: `../etc/passwd` was rejected before FDX execution. |
| Streaming-HTTP smoke test | Passed: authenticated `initialize` returned `200` and a session ID; initialized notification returned `202`; tool listing returned all 18 tools. |
| Remote authorization probes | Passed: missing bearer returned `401`; a disallowed origin returned `403`; non-loopback binding was rejected. |
| Expanded code-intelligence smoke test | Passed: `fdx_code_grep` completed through the lifecycle-correct stdio MCP path. |

## ChatGPT deployment requirements

A production or test ChatGPT app must use a public HTTPS URL that forwards to `fdx mcp http` on loopback. The reverse proxy must validate ChatGPT OAuth credentials and repository authorization, rate-limit requests, and inject the private local FDX bearer token. It must not forward arbitrary user-supplied bearer tokens to FDX and must not expose the FDX process directly to the internet.

The operational command is documented in [`docs/reference/fdx-mcp.md`](../docs/reference/fdx-mcp.md). The public URL supplied to ChatGPT should be the proxy’s HTTPS `/mcp` endpoint, not the loopback URL.

## Remaining non-blocking enhancements

The audit considers the tool layer implementation-ready. The following are product enhancements rather than blockers: adding stable per-tool `outputSchema` contracts, adding server-side rate-limit telemetry at the reverse proxy, providing a reference OAuth reverse-proxy deployment template, and adding a client-visible progress notification path for long verification executions.

## References

[1]: https://developers.openai.com/api/docs/guides/developer-mode "OpenAI: ChatGPT Developer mode"
[2]: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports "Model Context Protocol: Transports"
[3]: https://modelcontextprotocol.io/specification/2025-03-26/basic/lifecycle "Model Context Protocol: Lifecycle"
[4]: https://modelcontextprotocol.io/specification/2025-06-18/server/tools "Model Context Protocol: Tools"
