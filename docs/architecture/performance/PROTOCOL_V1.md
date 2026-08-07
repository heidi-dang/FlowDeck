# FDX Daemon Protocol v1

**Developer:** Dev 3
**Program:** FDX and Tool Performance
**Frozen FlowDeck harness:** v1.0.3
**Status:** Implemented (Task 2) — protocol version 1

---

## 1. Overview

`fdxd` (the FDX daemon) and its clients speak a versioned, newline-delimited
JSON (NDJSON) protocol. One JSON message per line over a byte stream; no
binary framing, no length prefixes — the newline is the delimiter.

Two transports in Task 2:

| Transport | Platform | Mode | Notes |
|---|---|---|---|
| `stdio` | all | one-shot (`fdxd --stdio`) | Client spawns the daemon and talks over stdin/stdout. Deterministic, testable, no filesystem state. |
| `unix` | Linux/macOS | persistent (`fdxd --socket <path>`) | Unix domain socket; daemon serves one client at a time, idle-exits. |

**Windows named pipes are NOT implemented in Task 2.** The transport trait is
transport-agnostic, but the daemon does not claim a `pipe` capability on
Windows: on Windows the client uses `stdio` (or falls back to one-shot). See
[Unsupported platform capabilities](#9-unsupported-platform-capabilities).

**No TCP listener is introduced.** The production transports are unix socket,
stdio, and (future) Windows named pipe. There is no network transport and no
TCP port in use.

## 2. Framing

- Each message is exactly one line of JSON, terminated by `\n`.
- Blank lines are ignored (keepalive/whitespace tolerance).
- **Maximum message size:** 64 KiB (`MAX_MESSAGE_BYTES`). A message exceeding
  the cap is rejected with `E_TOO_LARGE` **before** unbounded buffering — the
  reader accumulates at most the cap, then fails the frame.
- UTF-8 only. A non-UTF-8 line is a transport error.

## 3. Request envelope

Client → daemon. `id` is `null` for notifications (no response expected).

```json
{"v":1,"id":1,"method":"hello","params":{"client":"flowdeck","clientVersion":"1.0.3"}}
{"v":1,"id":2,"method":"ping"}
{"v":1,"id":3,"method":"query","params":{"command":"read","argv":["src/main.rs","--limit","20"],"cwd":"/repo","cancelId":3}}
{"v":1,"id":4,"method":"batch","params":{"requests":[{"v":1,"id":5,"method":"ping"},{"v":1,"id":6,"method":"query","params":{"command":"version","argv":[]}}]}}
{"v":1,"id":null,"method":"cancel","params":{"targetId":3}}
{"v":1,"id":null,"method":"shutdown"}
```

| Field | Type | Meaning |
|---|---|---|
| `v` | number | Wire protocol version. Must be `1`. |
| `id` | number \| null | Correlation id. Non-null requests expect a response. |
| `method` | string | One of `hello`, `ping`, `query`, `batch`, `cancel`, `shutdown`. |
| `params` | object | Method-specific parameters (omit for `ping`/`shutdown`). |

## 4. Response envelope

Daemon → client.

```json
{"v":1,"id":1,"ok":true,"result":{"capabilities":{...}}}
{"v":1,"id":2,"ok":true,"result":{"pong":true,"version":"0.1.0","uptimeMs":12}}
{"v":1,"id":3,"ok":true,"result":{"stdout":"...","exitCode":0,"durationMs":1.2,"cached":false}}
{"v":1,"id":4,"ok":true,"result":{"responses":[{"v":1,"id":5,"ok":true,"result":{...}},{"v":1,"id":6,"ok":true,"result":{...}}]}}
{"v":1,"id":null,"ok":true,"event":"cancel-ack","result":{"targetId":3,"status":"not-in-flight"}}
{"v":1,"id":null,"ok":true,"event":"shutdown-ack","result":{"shuttingDown":true}}
{"v":1,"id":3,"ok":false,"error":{"code":"E_UNSUPPORTED","message":"command 'search' is not hosted in the daemon yet"}}
```

| Field | Type | Meaning |
|---|---|---|
| `v` | number | Protocol version (always echoes `1`). |
| `id` | number \| null | Echoes the request id, or `null` for server events. |
| `ok` | boolean | `true` on success. |
| `event` | string | Server-initiated event tag: `cancel-ack`, `shutdown-ack`. |
| `result` | object | Success payload (absent on error). |
| `error` | object | `{code, message}` — present only when `ok` is false. |

## 5. Request IDs

- The client chooses a per-connection monotonically increasing id.
- Responses echo the request id; the client correlates by id.
- A response with an unknown/stale id is ignored by the client.
- `batch` envelopes carry their own id; each **sub-request** carries its own
  id, returned as an array in the batch response. Sub-ids must not collide
  with the batch envelope id.
- Notifications (`cancel`, `shutdown`) have `id: null`; the daemon may still
  send events with `id: null`.

## 6. Protocol version

- `PROTOCOL_VERSION = 1`.
- The daemon rejects requests with `v != 1` → `E_BAD_REQUEST`
  ("unsupported protocol version").
- `hello` returns `capabilities.protocol`, which the client MUST validate
  against its own version before use. On mismatch the client falls back to
  one-shot spawning (fallback reason `daemon-incompatible`).

## 7. Capabilities

The `hello` response reports what the daemon actually implements — capability
claims never exceed implemented behaviour:

```json
"capabilities": {
  "protocol": 1,
  "methods": ["hello", "ping", "query", "batch", "cancel", "shutdown"],
  "commands": ["version", "read", "ls"],
  "transport": "stdio" | "unix",
  "version": "0.1.0",
  "pid": 12345
}
```

| Field | Meaning |
|---|---|
| `methods` | Accepted request methods. |
| `commands` | Query commands hosted in-process. Anything else → `E_UNSUPPORTED`. |
| `transport` | The transport the daemon is currently serving over. |

## 8. Commands

Task 2 hosts a minimal in-process command surface (more land with the index
in Tasks 3–5):

| Command | Args | Result |
|---|---|---|
| `version` | — | `{"version":"0.1.0","protocol":1}` |
| `read` | `<file> [--offset N] [--limit N]` | `{"result":{...TextResult...},"cached":false}` |
| `ls` | `[path]` | `{"entries":[{"name":...,"is_dir":...}],"cached":false}` |

Any other command (e.g. `search`) → `E_UNSUPPORTED`; the client falls back to
the one-shot `fdx` spawn (fallback reason `command-not-hosted`).

## 9. Errors

| Code | Meaning |
|---|---|
| `E_BAD_REQUEST` | Malformed JSON, wrong `v`, empty required params, unknown method, empty batch, or ANY invalid batch operation (unknown / mutating / non-batchable — whole-batch preflight rejection). |
| `E_TOO_LARGE` | Frame exceeds 64 KiB; rejected before unbounded buffering. |
| `E_UNSUPPORTED` | Command not hosted in-process. |
| `E_INTERNAL` | Hosted command failed (e.g. file read error). |
| `E_CANCELLED` | An unstarted batch operation after a `failFast` stop (see §10). |
| `E_STALE_SNAPSHOT` | An unstarted batch operation after repository-state drift mid-batch (see §10). |
| `E_NO_SUCH_REQUEST` | Reserved for cancel of a request the daemon never saw. |

Errors are structured `{code, message}` — never empty "successful" results.

## 10. Cancellation

- Client sends `{"v":1,"id":null,"method":"cancel","params":{"targetId":N}}`.
- Daemon acks with event `cancel-ack` and `result.status`:
  - `cancelled` — the target was in-flight and is being interrupted.
  - `not-in-flight` — the target is not currently executing (Task 2 executes
    queries synchronously, so this is the common case; real interruption of
    long scans lands in Task 7).
- The client cancels by the request id it originally sent.

### Typed batch `failFast` (Task 4, Phase 7)

The typed `batch` method accepts `params.failFast: true`. Semantics are
identical across daemon, one-shot `fdx batch-query --fail-fast`, and the
pure-TS fallback:

- Operations execute in input order; the batch stops at the first failed
  operation and reports `failedFast: true`.
- Every **unstarted** operation returns an explicit
  `{"ok":false,"error":{"code":"E_CANCELLED","message":"operation cancelled by fail-fast"}}`
  response — it is never executed and never touches the cache.
- The response always contains **exactly one entry per input operation**, in
  input order, with every id preserved (cardinality contract). No missing
  entries, no partial truncation.
- Completed operations keep their responses; cancelled operations write no
  positive or negative cache entries.

### Typed batch whole-batch preflight (Phase 7 audit)

The typed `batch` method validates the ENTIRE batch before any operation
executes (zero execution):

- Structural violations — empty `operations`, more than 64 operations,
  duplicate operation ids — reject the whole batch with `E_BAD_REQUEST`
  (no `BatchResponse` is produced).
- **Any** invalid operation — an unknown operation tag, a non-read-only
  operation (`index.refresh` & co), or a non-batchable hosted command
  (`capabilities.query`) — also rejects the WHOLE batch with `E_BAD_REQUEST`
  before ANY operation executes. A valid op alongside an invalid op is never
  executed: there are no partial results.
- This contract is identical across the daemon `batch` method, the one-shot
  `fdx batch-query` CLI (which exits non-zero with
  `Error: batch rejected (E_BAD_REQUEST): <message>` on stderr), and the
  pure-TS fallback (which throws the same `{code, message}`).

### Typed batch repository-state drift (Phase 7 audit)

The batch captures the repository identity fields (HEAD SHA, dirty
working-tree fingerprint, configuration fingerprint) at batch start and
revalidates them before every operation and before the final response is
emitted. If ANY captured field changed mid-batch:

- Every **remaining** (unstarted) operation is aborted with
  `{"ok":false,"error":{"code":"E_STALE_SNAPSHOT","message":"operation aborted: repository state changed mid-batch"}}`
  — it is never executed and never touches the cache.
- The batch response reports `staleSnapshot: true`, so clients never persist
  results that span two repository states.
- `E_STALE_SNAPSHOT` is distinct from `E_CANCELLED`: the batch was not stopped
  by the client (`failFast`); it was invalidated by an external mutation.
- The response always contains exactly one entry per input operation, in
  input order, with every id preserved (cardinality contract).

## 11. Shutdown

- `{"v":1,"id":null,"method":"shutdown"}` (notification).
- The daemon responds `{"ok":true,"result":{"shuttingDown":true}}` and exits
  with code 0. On `--socket` mode it removes the socket file first.

## 12. Idle exit

- The daemon exits after `--idle <seconds>` of no activity (default 300 s).
- Idle is tracked daemon-wide: no connection AND no traffic for the window →
  exit 0; a silent attached client also triggers exit after the window.
- The daemon never exits mid-request: idle is only checked between messages.
- Idle-exit removes the socket file, so a stale endpoint is never left behind.

## 13. Compatibility

- Clients that cannot reach a daemon, or find an incompatible one, fall back
  to the existing one-shot `fdx` spawn — the pre-daemon behaviour is a
  first-class fallback, never broken.
- Protocol evolution is versioned: a future `v:2` daemon must reject `v:1`
  clients explicitly (or the client detects `capabilities.protocol != 1` and
  falls back). Wire format is never changed silently.

## 14. Fallback

The client ladder (see `src/tools/fdx-daemon-client.ts`):

```
daemon (hello + query)
  → one-shot native fdx spawn (runFdx)
  → TypeScript fallbacks (read/search/ls/outline/git)
```

- Fallback reason is reported structurally (`daemon-unavailable`,
  `daemon-incompatible`, `daemon-not-ready`, `daemon-crashed`,
  `daemon-timeout`, `command-not-hosted`, `native-unavailable`, `disabled`).
- No infinite loops: at most one daemon-start attempt per request; if the
  daemon fails, the client goes straight to one-shot and never retries the
  daemon within that request.
- `FDX_DISABLE_FALLBACK=1` forces the native path and reports `disabled` on
  failure (strict mode, used by the parity gate).

## 15. Security assumptions

- The unix socket path is user-scoped (`/tmp/fdxd-<uid>-<hash>.sock`) and
  per-project, preventing cross-user and cross-worktree collision.
- No TCP listener, no network exposure.
- The daemon binds a filesystem socket; access is governed by filesystem
  permissions (the owning user's `/tmp`). No secrets travel over the wire.
- Frame and response sizes are bounded (64 KiB messages; the client bounds
  its receive buffer) so a hostile/misbehaving peer cannot exhaust memory.
- A malformed message produces a structured `E_BAD_REQUEST` response and does
  not terminate the daemon.

## 16. Unsupported platform capabilities

- **Windows named pipe: NOT implemented in Task 2.** The daemon does not
  claim `transport: "pipe"` on Windows. Windows clients use `--stdio` or the
  one-shot fallback. Named-pipe support will land behind the transport trait
  in a later task; until then the client never assumes it exists.
- **`--socket` mode on Windows: unsupported** — `fdxd --socket` exits with a
  clear error and the client uses stdio/one-shot instead.

## 17. Future evolution

- Task 3–5: the index lands; `commands` grows (search, outline, impact, ...),
  `cached: true` appears for cache hits.
- Task 6: client batching coalescing; `batch` becomes the primary path.
- Task 7: real cancellation of long scans (`E_CANCELLED` for in-flight
  interruption, `cancelled` status; fail-fast batch cancellation already uses
  `E_CANCELLED` today).
- Task 8: hard output caps per response with truncation metadata (landed:
  per-op + batch-total caps with artifact spill and content hashes).
- Later: Windows named-pipe transport (`transport: "pipe"`).

Each evolution bumps nothing in v1 unless the wire format changes; capability
negotiation means old clients keep working via fallback.

## 18. Reference implementation

- Rust protocol types + validation: `crates/fdx/src/daemon/protocol.rs`
- Transport framing (stdio + unix): `crates/fdx/src/daemon/transport.rs`
- Server lifecycle + dispatch: `crates/fdx/src/daemon/server.rs`
- Daemon binary: `crates/fdx/src/bin/fdxd.rs`
- TypeScript client + fallback ladder: `src/tools/fdx-daemon-client.ts`
- Protocol tests (TS): `tests/fdx-protocol.test.ts`
- Lifecycle tests (TS): `tests/fdx-daemon.test.ts`
- Rust tests: `crates/fdx/src/daemon/{protocol,transport,server}.rs`
