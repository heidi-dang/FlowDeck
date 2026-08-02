//! FDX daemon — protocol v1 types and validation.
//!
//! The wire format is newline-delimited JSON (NDJSON): exactly one JSON
//! message per line over any byte stream (stdio, unix socket, named pipe).
//! Every message is self-delimiting so both ends can stream without a
//! framing layer.
//!
//! Protocol version 1 message shape:
//!
//! Request (client -> daemon):
//!   {"v":1,"id":1,"method":"hello","params":{"client":"flowdeck","clientVersion":"1.0.3"}}
//!   {"v":1,"id":2,"method":"ping"}
//!   {"v":1,"id":3,"method":"query","params":{"command":"read","argv":["src/main.rs"],"cwd":"/repo"}}
//!   {"v":1,"id":4,"method":"batch","params":{"requests":[...]}}
//!   {"v":1,"id":null,"method":"cancel","params":{"targetId":3}}
//!   {"v":1,"id":null,"method":"shutdown"}
//!
//! Response (daemon -> client):
//!   {"v":1,"id":1,"ok":true,"result":{...}}
//!   {"v":1,"id":3,"ok":true,"result":{"stdout":"...","exitCode":0,"durationMs":1.2,"cached":false}}
//!   {"v":1,"id":null,"ok":true,"event":"cancel-ack","result":{"targetId":3,"status":"cancelled"}}
//!   {"v":1,"id":null,"ok":true,"event":"shutdown-ack"}
//!   {"v":1,"id":3,"ok":false,"error":{"code":"E_UNSUPPORTED","message":"..."}}

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Wire protocol version spoken by this implementation.
pub const PROTOCOL_VERSION: u32 = 1;

/// Max size of a single NDJSON message (64 KB). Messages beyond this are
/// rejected with `E_TOO_LARGE` — the first output-bounding line of defense;
/// response bodies are bounded separately by the server.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;

/// Error codes understood by protocol v1 clients.
pub mod err {
    pub const E_BAD_REQUEST: &str = "E_BAD_REQUEST";
    pub const E_TOO_LARGE: &str = "E_TOO_LARGE";
    pub const E_UNSUPPORTED: &str = "E_UNSUPPORTED";
    pub const E_CANCELLED: &str = "E_CANCELLED";
    pub const E_INTERNAL: &str = "E_INTERNAL";
    pub const E_NO_SUCH_REQUEST: &str = "E_NO_SUCH_REQUEST";
}

/// Client capability set negotiated in `hello`. Grows as later tasks land
/// (batch multiplexing, cancellation of long scans, named-pipe transport).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Capabilities {
    /// Protocol version the daemon speaks.
    pub protocol: u32,
    /// Methods the daemon accepts: hello, ping, query, batch, cancel, shutdown.
    pub methods: Vec<String>,
    /// Query commands hosted in-process. Unlisted commands return
    /// `E_UNSUPPORTED` and the client falls back to one-shot spawn.
    pub commands: Vec<String>,
    /// Transport the daemon is currently serving over: stdio | unix | pipe.
    pub transport: String,
    /// Daemon binary version (mirrors `fdx --version`).
    pub version: String,
    /// Process id of the daemon, for client crash-recovery checks.
    pub pid: u32,
}

// ─── Requests ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Request {
    /// Wire protocol version. Must equal [`PROTOCOL_VERSION`].
    pub v: u32,
    /// Client-chosen correlation id. `null` for notifications (shutdown).
    pub id: Option<u64>,
    #[serde(flatten)]
    pub body: RequestBody,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "kebab-case")]
pub enum RequestBody {
    /// Session handshake: negotiate protocol + capabilities.
    Hello { params: HelloParams },
    /// Liveness probe.
    Ping,
    /// Execute a single hosted command in-process.
    Query { params: QueryParams },
    /// Execute several queries in one round-trip.
    Batch { params: BatchParams },
    /// Ask the daemon to stop a long-running request.
    Cancel { params: CancelParams },
    /// Graceful shutdown (notification — no response expected).
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloParams {
    /// Client name, e.g. "flowdeck".
    pub client: String,
    /// Client version, e.g. "1.0.3".
    pub client_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryParams {
    /// Command to run, e.g. "read" or "ls".
    pub command: String,
    /// Command arguments (mirror the one-shot `fdx` CLI argv).
    #[serde(default)]
    pub argv: Vec<String>,
    /// Working directory to resolve relative paths against.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Client-supplied cancellation token; daemon acks cancellation of the
    /// request with this id.
    #[serde(default)]
    pub cancel_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BatchParams {
    /// Batch protocol version. Present (1) with non-empty `operations`
    /// selects the typed read-only batch path (Task 4). Absent/legacy
    /// clients keep using `requests` (Task 2 multiplexing).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<u32>,
    /// Typed batch operations (Task 4). When non-empty, the daemon executes
    /// them as one frozen-snapshot batch instead of the legacy multiplexer.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub operations: Vec<crate::batch::BatchOperation>,
    /// Working directory for the typed path: resolves relative paths and
    /// selects the worktree index service (`testsFor`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Legacy sub-requests; each carries its own `id` (they must not collide
    /// with the batch envelope id, which is reserved for the batch response).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requests: Vec<Request>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    /// Request id the client wants cancelled.
    pub target_id: u64,
}

// ─── Responses ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    /// Wire protocol version.
    pub v: u32,
    /// Echoes the request id, or `null` for server events.
    pub id: Option<u64>,
    /// True on success; `error` is set when false.
    pub ok: bool,
    /// Event tag for server-initiated messages (cancel-ack, shutdown-ack).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    /// Success payload.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Error payload when `ok` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorInfo {
    /// Stable error code from [`err`].
    pub code: String,
    /// Human-readable message.
    pub message: String,
}

// ─── Construction helpers ───────────────────────────────────────────────────

impl Request {
    /// Build a request with the wire protocol version stamped.
    pub fn new(id: Option<u64>, body: RequestBody) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id,
            body,
        }
    }
}

impl Response {
    pub fn ok(id: Option<u64>, result: Value) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id,
            ok: true,
            event: None,
            result: Some(result),
            error: None,
        }
    }

    pub fn event(id: Option<u64>, tag: &str, result: Value) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id,
            ok: true,
            event: Some(tag.to_string()),
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Option<u64>, code: &str, message: impl Into<String>) -> Self {
        Self {
            v: PROTOCOL_VERSION,
            id,
            ok: false,
            event: None,
            result: None,
            error: Some(ErrorInfo {
                code: code.to_string(),
                message: message.into(),
            }),
        }
    }
}

// ─── Validation ─────────────────────────────────────────────────────────────

/// Validate a parsed request. Returns `Ok(())` or the error code + message.
pub fn validate_request(req: &Request) -> Result<(), (&'static str, String)> {
    if req.v != PROTOCOL_VERSION {
        return Err((
            err::E_BAD_REQUEST,
            format!(
                "unsupported protocol version {} (daemon speaks v{PROTOCOL_VERSION})",
                req.v
            ),
        ));
    }
    match &req.body {
        RequestBody::Hello { params } => {
            if params.client.is_empty() {
                return Err((
                    err::E_BAD_REQUEST,
                    "hello.params.client must not be empty".into(),
                ));
            }
        }
        RequestBody::Query { params } => {
            if params.command.is_empty() {
                return Err((
                    err::E_BAD_REQUEST,
                    "query.params.command must not be empty".into(),
                ));
            }
            if let Some(cid) = params.cancel_id {
                if req.id.is_none() {
                    return Err((
                        err::E_BAD_REQUEST,
                        format!("query carries cancel_id {cid} but no request id"),
                    ));
                }
            }
        }
        RequestBody::Batch { params } => {
            let typed = !params.operations.is_empty();
            let legacy = !params.requests.is_empty();
            if typed || !legacy {
                // Typed path. An empty `operations` array with no legacy
                // requests reaches `execute_batch`, whose canonical rejection
                // matches the one-shot CLI and the TS fallback.
                if let Some(v) = params.version {
                    if v != 1 {
                        return Err((
                            err::E_BAD_REQUEST,
                            format!("unsupported batch protocol version {v} (daemon speaks v1)"),
                        ));
                    }
                }
            } else if params.requests.is_empty() {
                return Err((
                    err::E_BAD_REQUEST,
                    "batch.params.requests must not be empty".into(),
                ));
            }
        }
        RequestBody::Cancel { .. } | RequestBody::Ping | RequestBody::Shutdown => {}
    }
    Ok(())
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> Result<Request, serde_json::Error> {
        serde_json::from_str(line)
    }

    #[test]
    fn hello_round_trips() {
        let line = r#"{"v":1,"id":1,"method":"hello","params":{"client":"flowdeck","clientVersion":"1.0.3"}}"#;
        let req: Request = parse(line).expect("parses");
        assert_eq!(req.v, 1);
        assert_eq!(req.id, Some(1));
        match &req.body {
            RequestBody::Hello { params } => {
                assert_eq!(params.client, "flowdeck");
                assert_eq!(params.client_version, "1.0.3");
            }
            other => panic!("expected hello, got {other:?}"),
        }
        assert!(validate_request(&req).is_ok());
    }

    #[test]
    fn ping_round_trips() {
        let line = r#"{"v":1,"id":2,"method":"ping"}"#;
        let req: Request = parse(line).expect("parses");
        assert!(matches!(req.body, RequestBody::Ping));
        assert!(validate_request(&req).is_ok());
    }

    #[test]
    fn query_round_trips_with_argv() {
        let line = r#"{"v":1,"id":3,"method":"query","params":{"command":"read","argv":["src/main.rs"],"cwd":"/repo"}}"#;
        let req: Request = parse(line).expect("parses");
        match &req.body {
            RequestBody::Query { params } => {
                assert_eq!(params.command, "read");
                assert_eq!(params.argv, vec!["src/main.rs"]);
                assert_eq!(params.cwd.as_deref(), Some("/repo"));
            }
            other => panic!("expected query, got {other:?}"),
        }
        assert!(validate_request(&req).is_ok());
    }

    #[test]
    fn cancel_and_shutdown_round_trip() {
        let cancel: Request =
            parse(r#"{"v":1,"id":null,"method":"cancel","params":{"targetId":3}}"#).unwrap();
        assert!(matches!(cancel.body, RequestBody::Cancel { ref params } if params.target_id == 3));
        assert!(validate_request(&cancel).is_ok());

        let shutdown: Request = parse(r#"{"v":1,"id":null,"method":"shutdown"}"#).unwrap();
        assert!(matches!(shutdown.body, RequestBody::Shutdown));
        assert!(validate_request(&shutdown).is_ok());
    }

    #[test]
    fn batch_round_trips_nested_requests() {
        let line = r#"{"v":1,"id":4,"method":"batch","params":{"requests":[{"v":1,"id":5,"method":"ping"}]}}"#;
        let req: Request = parse(line).expect("parses");
        match &req.body {
            RequestBody::Batch { params } => {
                assert_eq!(params.requests.len(), 1);
                assert_eq!(params.requests[0].id, Some(5));
                assert!(params.operations.is_empty());
            }
            other => panic!("expected batch, got {other:?}"),
        }
        assert!(validate_request(&req).is_ok());
    }

    #[test]
    fn typed_batch_round_trips_operations() {
        let line = r#"{"v":1,"id":4,"method":"batch","params":{"version":1,"operations":[
            {"id":"a","op":"read","params":{"file":"src/main.rs"}},
            {"id":"b","op":"grep","params":{"pattern":"fn","paths":["src"]}}
        ]}}"#;
        let req: Request = parse(line).expect("parses");
        match &req.body {
            RequestBody::Batch { params } => {
                assert_eq!(params.version, Some(1));
                assert_eq!(params.operations.len(), 2);
                assert_eq!(params.operations[0].id, "a");
                assert_eq!(params.operations[0].op, "read");
                assert_eq!(params.operations[1].op, "grep");
                assert!(params.requests.is_empty());
            }
            other => panic!("expected batch, got {other:?}"),
        }
        assert!(validate_request(&req).is_ok());
    }

    #[test]
    fn rejects_bad_batch_protocol_version() {
        let line = r#"{"v":1,"id":4,"method":"batch","params":{"version":2,"operations":[{"id":"a","op":"read","params":{}}]}}"#;
        let req: Request = parse(line).unwrap();
        let (code, msg) = validate_request(&req).unwrap_err();
        assert_eq!(code, err::E_BAD_REQUEST);
        assert!(msg.contains("unsupported batch protocol version 2"));
    }

    #[test]
    fn rejects_wrong_protocol_version() {
        let line = r#"{"v":99,"id":1,"method":"ping"}"#;
        let req: Request = parse(line).unwrap();
        let (code, msg) = validate_request(&req).unwrap_err();
        assert_eq!(code, err::E_BAD_REQUEST);
        assert!(msg.contains("unsupported protocol version 99"));
    }

    #[test]
    fn rejects_empty_client() {
        let line =
            r#"{"v":1,"id":1,"method":"hello","params":{"client":"","clientVersion":"1.0.3"}}"#;
        let req: Request = parse(line).unwrap();
        let (code, _) = validate_request(&req).unwrap_err();
        assert_eq!(code, err::E_BAD_REQUEST);
    }

    #[test]
    fn rejects_empty_query_command() {
        let line = r#"{"v":1,"id":3,"method":"query","params":{"command":""}}"#;
        let req: Request = parse(line).unwrap();
        let (code, _) = validate_request(&req).unwrap_err();
        assert_eq!(code, err::E_BAD_REQUEST);
    }

    #[test]
    fn empty_batch_defers_rejection_to_executor() {
        // An empty batch (no operations, no legacy requests) passes request
        // validation so it reaches `execute_batch`, whose canonical
        // E_BAD_REQUEST matches the one-shot CLI and the TS fallback
        // ("batch.operations must not be empty"). The executor-layer
        // rejection is asserted in `batch::tests`.
        let line = r#"{"v":1,"id":4,"method":"batch","params":{"requests":[]}}"#;
        let req: Request = parse(line).unwrap();
        assert!(validate_request(&req).is_ok());
        let typed_line = r#"{"v":1,"id":5,"method":"batch","params":{"operations":[]}}"#;
        let typed: Request = parse(typed_line).unwrap();
        assert!(validate_request(&typed).is_ok());
    }

    #[test]
    fn response_helpers_build_valid_wire_shape() {
        let ok = Response::ok(Some(1), serde_json::json!({"pong": true}));
        let ok_str = serde_json::to_string(&ok).unwrap();
        assert!(ok_str.contains("\"ok\":true"));

        let err = Response::error(Some(3), err::E_UNSUPPORTED, "not hosted");
        let err_str = serde_json::to_string(&err).unwrap();
        assert!(err_str.contains("\"ok\":false"));
        assert!(err_str.contains("\"code\":\"E_UNSUPPORTED\""));

        let evt = Response::event(None, "cancel-ack", serde_json::json!({"targetId": 3}));
        let evt_str = serde_json::to_string(&evt).unwrap();
        assert!(evt_str.contains("\"event\":\"cancel-ack\""));
    }

    #[test]
    fn capabilities_serialize() {
        let caps = Capabilities {
            protocol: 1,
            methods: vec![
                "hello".into(),
                "ping".into(),
                "query".into(),
                "batch".into(),
                "cancel".into(),
                "shutdown".into(),
            ],
            commands: vec!["version".into(), "read".into(), "ls".into()],
            transport: "stdio".into(),
            version: "0.1.0".into(),
            pid: 1234,
        };
        let s = serde_json::to_string(&caps).unwrap();
        let back: Capabilities = serde_json::from_str(&s).unwrap();
        assert_eq!(back, caps);
    }
}
