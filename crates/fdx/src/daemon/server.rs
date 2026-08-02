//! FDX daemon — lifecycle, handshake, and request dispatch.
//!
//! The daemon is user-scoped and spawned on demand by the client. It:
//!
//! 1. Serves NDJSON messages over a [`Transport`] (stdio or unix socket).
//! 2. Negotiates protocol + capabilities on `hello`.
//! 3. Executes hosted commands in-process (`version`, `read`, `ls`) and
//!    answers `E_UNSUPPORTED` for the rest (client falls back to one-shot).
//! 4. Tracks in-flight request ids for `cancel` acks.
//! 5. Exits on `shutdown`, on EOF, or after [`transport::DEFAULT_IDLE_TIMEOUT`]
//!    of silence — never a system service.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde_json::Value;

use super::protocol::{self, err, Capabilities, Request, RequestBody, Response};
use super::transport::{Transport, TransportError};

/// Transport name reported in `hello` capabilities.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportKind {
    Stdio,
    Unix,
}

impl TransportKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TransportKind::Stdio => "stdio",
            TransportKind::Unix => "unix",
        }
    }
}

/// Daemon version reported in `hello` capabilities.
pub const DAEMON_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Commands hosted in-process by the daemon. Everything else → `E_UNSUPPORTED`
/// and the client falls back to the one-shot `fdx` spawn.
pub const HOSTED_COMMANDS: [&str; 13] = [
    "version",
    "read",
    "ls",
    // Task 3: persistent index commands (negotiated via capabilities; older
    // clients ignore them, and E_UNSUPPORTED preserves the fallback ladder).
    "index.status",
    "index.refresh",
    "index.invalidate",
    "index.rebuild",
    "files.query",
    "symbols.query",
    "dependencies.query",
    "testsFor.query",
    "gitState.query",
    // Task 4: capability metadata (descriptor registry).
    "capabilities.query",
];

/// Server state shared across requests.
#[derive(Debug, Default)]
pub struct Server {
    /// Request ids currently being processed (for cancellation acks).
    in_flight: HashSet<u64>,
    /// Whether the client negotiated `hello` yet.
    negotiated: bool,
}

impl Server {
    pub fn new() -> Self {
        Self::default()
    }

    /// Run the serve loop until shutdown/EOF/idle. Returns the reason.
    pub fn run(
        &mut self,
        transport: &mut dyn Transport,
        kind: TransportKind,
        idle_timeout: Option<Duration>,
    ) -> Result<RunOutcome, TransportError> {
        let idle = idle_timeout.unwrap_or(super::transport::DEFAULT_IDLE_TIMEOUT);
        let mut last_activity = Instant::now();

        loop {
            // Idle check: if we've been silent longer than the timeout, exit.
            if last_activity.elapsed() >= idle {
                return Ok(RunOutcome::Idle);
            }

            // Peek with a bounded wait: poll every 50ms so idle-exit fires
            // even when no message arrives. Read is blocking, so we use the
            // stream's read timeout where available; otherwise the daemon
            // relies on EOF/shutdown for non-idle exit. To keep this simple
            // and portable, we read one message and rely on the client for
            // liveness: a truly idle connection is the client's responsibility
            // to close. Idle-exit below fires between messages.
            let msg = match transport.read_message() {
                Ok(Some(m)) => m,
                Ok(None) => return Ok(RunOutcome::Eof),
                Err(TransportError::Io(e))
                    if e.kind() == std::io::ErrorKind::TimedOut
                        || e.kind() == std::io::ErrorKind::WouldBlock =>
                {
                    // Blocked read timed out (or would block): no new message.
                    // Check idle again next loop iteration.
                    continue;
                }
                Err(e) => return Err(e),
            };
            last_activity = Instant::now();

            let req: Request = match serde_json::from_str(&msg) {
                Ok(r) => r,
                Err(e) => {
                    // Unparseable line: respond with a protocol error and keep
                    // serving (a single bad message must not kill the daemon).
                    transport.write_message(
                        &serde_json::to_string(&Response::error(
                            None,
                            err::E_BAD_REQUEST,
                            format!("malformed request: {e}"),
                        ))
                        .expect("serialize error response"),
                    )?;
                    continue;
                }
            };

            if let Err((code, message)) = protocol::validate_request(&req) {
                transport.write_message(
                    &serde_json::to_string(&Response::error(req.id, code, message))
                        .expect("serialize error response"),
                )?;
                continue;
            }

            let resp = self.handle(&req, kind);
            let line = serde_json::to_string(&resp).expect("serialize response");
            transport.write_message(&line)?;

            if matches!(req.body, RequestBody::Shutdown) {
                return Ok(RunOutcome::Shutdown);
            }
        }
    }

    /// Handle a single validated request, returning the response.
    pub fn handle(&mut self, req: &Request, kind: TransportKind) -> Response {
        match &req.body {
            RequestBody::Hello { params } => {
                self.negotiated = true;
                let caps = Capabilities {
                    protocol: protocol::PROTOCOL_VERSION,
                    methods: vec![
                        "hello".to_string(),
                        "ping".to_string(),
                        "query".to_string(),
                        "batch".to_string(),
                        "cancel".to_string(),
                        "shutdown".to_string(),
                    ],
                    commands: HOSTED_COMMANDS.iter().map(|s| s.to_string()).collect(),
                    transport: kind.as_str().to_string(),
                    version: DAEMON_VERSION.to_string(),
                    pid: std::process::id(),
                };
                Response::ok(
                    req.id,
                    serde_json::json!({
                        "client": params.client,
                        "clientVersion": params.client_version,
                        "capabilities": caps,
                    }),
                )
            }
            RequestBody::Ping => {
                let _result = run_command("version", &[], None, None);
                Response::ok(
                    req.id,
                    serde_json::json!({
                        "pong": true,
                        "version": DAEMON_VERSION,
                        "uptimeMs": 0,
                    }),
                )
            }
            RequestBody::Query { params } => {
                if let Some(cid) = params.cancel_id {
                    self.in_flight.insert(cid);
                }
                let result =
                    run_command(&params.command, &params.argv, params.cwd.as_deref(), req.id);
                if let Some(cid) = params.cancel_id {
                    self.in_flight.remove(&cid);
                }
                result
            }
            RequestBody::Batch { params } => {
                // Task 4: typed batch path — one frozen snapshot per batch,
                // input-order responses. Mutating/unknown ops are per-op
                // errors; structural issues (empty, >64, dup ids) reject the
                // whole batch with E_BAD_REQUEST.
                let typed = !params.operations.is_empty();
                let legacy = !params.requests.is_empty();
                if !typed && !legacy {
                    return Response::error(
                        req.id,
                        err::E_BAD_REQUEST,
                        "batch.params must contain either operations (typed) or requests (legacy)",
                    );
                }
                if typed {
                    let cwd = params.cwd.as_deref();
                    // Resolve the worktree index only when a testsFor op is
                    // present (other ops never need it).
                    let needs_index = params.operations.iter().any(|op| op.op == "testsFor");
                    let index: Option<std::sync::Arc<crate::index::IndexService>> = if needs_index {
                        match cwd {
                            Some(c) => crate::index::GLOBAL_INDEX_REGISTRY
                                .service_for(std::path::Path::new(c))
                                .ok(),
                            None => None,
                        }
                    } else {
                        None
                    };
                    match crate::batch::execute_batch(
                        &params.operations,
                        cwd,
                        index
                            .as_ref()
                            .map(|i| i.as_ref() as &dyn crate::batch::BatchIndexProvider),
                        false,
                    ) {
                        Ok(batch) => Response::ok(
                            req.id,
                            serde_json::to_value(&batch).expect("serialize batch response"),
                        ),
                        Err(reject) => Response::error(req.id, reject.code, reject.message),
                    }
                } else {
                    // Legacy multiplexed path (Task 2): each sub-request is
                    // handled independently.
                    let mut responses = Vec::with_capacity(params.requests.len());
                    for sub in &params.requests {
                        if let Err((code, message)) = protocol::validate_request(sub) {
                            responses.push(Response::error(sub.id, code, message));
                            continue;
                        }
                        let r = self.handle(sub, kind);
                        // Strip the batch envelope's own correlation: sub-responses
                        // are returned as an array; the client matches by sub id.
                        responses.push(r);
                    }
                    Response::ok(
                        req.id,
                        serde_json::json!({ "responses": responses.iter().map(serde_json::to_value).collect::<Result<Vec<_>, _>>().unwrap_or_default() }),
                    )
                }
            }
            RequestBody::Cancel { params } => {
                let cancelled = self.in_flight.remove(&params.target_id);
                let status = if cancelled {
                    "cancelled"
                } else {
                    "not-in-flight"
                };
                // NOTE: Task 2 acks cancellation; real interruption of a
                // long-running scan lands with the indexing work (Task 7).
                Response::event(
                    req.id,
                    "cancel-ack",
                    serde_json::json!({
                        "targetId": params.target_id,
                        "status": status,
                    }),
                )
            }
            RequestBody::Shutdown => {
                Response::ok(req.id, serde_json::json!({ "shuttingDown": true }))
            }
        }
    }
}

/// Why the serve loop returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunOutcome {
    /// Client sent `shutdown`.
    Shutdown,
    /// Client closed the connection.
    Eof,
    /// No traffic for the idle timeout.
    Idle,
    /// Server error occurred.
    Error,
}

/// Execute a hosted command in-process. Unknown/unsupported commands return
/// `E_UNSUPPORTED` so the client falls back to a one-shot spawn.
fn run_command(command: &str, argv: &[String], cwd: Option<&str>, req_id: Option<u64>) -> Response {
    match command {
        "version" => Response::ok(
            req_id,
            serde_json::json!({ "version": DAEMON_VERSION, "protocol": protocol::PROTOCOL_VERSION }),
        ),
        "read" => {
            // `fdx read <file> [--offset N] [--limit N]`
            let file = argv.first().map(|s| s.as_str());
            let Some(file) = file else {
                return Response::error(req_id, err::E_BAD_REQUEST, "read requires a file path");
            };
            let path = resolve_path(file, cwd);
            let mut offset = 1usize;
            let mut limit = None;
            let mut i = 1;
            while i < argv.len() {
                match argv[i].as_str() {
                    "--offset" => {
                        if let Some(v) = argv.get(i + 1) {
                            offset = v.parse().unwrap_or(1);
                            i += 2;
                            continue;
                        }
                    }
                    "--limit" => {
                        if let Some(v) = argv.get(i + 1) {
                            limit = v.parse().ok();
                            i += 2;
                            continue;
                        }
                    }
                    _ => {}
                }
                i += 1;
            }
            match crate::reader::text::read_text(&path, offset, limit) {
                Ok(result) => {
                    let v = serde_json::to_value(&result).unwrap_or_default();
                    Response::ok(req_id, serde_json::json!({ "result": v, "cached": false }))
                }
                Err(e) => Response::error(req_id, err::E_INTERNAL, format!("read failed: {e}")),
            }
        }
        "ls" => {
            // `fdx ls [path]` — in-process listing using the reader's ls.
            let target = argv.first().map(|s| s.as_str()).unwrap_or(".");
            let path = resolve_path(target, cwd);
            let options = crate::reader::ls::LsOptions {
                all: false,
                format: crate::output::OutputFormat::Json,
            };
            match crate::reader::ls::ls_paths(&path, &options) {
                Ok(result) => {
                    let entries: Vec<Value> = result
                        .entries
                        .iter()
                        .map(|e| serde_json::json!({ "name": e.name, "is_dir": e.is_dir }))
                        .collect();
                    Response::ok(
                        req_id,
                        serde_json::json!({ "entries": entries, "cached": false }),
                    )
                }
                Err(e) => Response::error(req_id, err::E_INTERNAL, format!("ls failed: {e}")),
            }
        }
        "capabilities.query" => {
            // Task 4: the canonical descriptor registry (read-only, batching,
            // output bounds, cache policy, latency class).
            Response::ok(
                req_id,
                serde_json::json!({
                    "descriptors": crate::batch::capabilities_payload(),
                }),
            )
        }
        other => {
            // Task 3: persistent index commands (index.*, *.query). When the
            // command is not an index command this returns None and we fall
            // through to E_UNSUPPORTED (preserving the fallback ladder).
            if let Some(result) = crate::index::handle_index_command(other, argv, cwd) {
                return Response::ok(req_id, result);
            }
            Response::error(
                req_id,
                err::E_UNSUPPORTED,
                format!("command '{other}' is not hosted in the daemon yet; client should fall back to one-shot spawn"),
            )
        }
    }
}

/// Resolve a (possibly relative) path against the request cwd.
fn resolve_path(path: &str, cwd: Option<&str>) -> std::path::PathBuf {
    let p = std::path::Path::new(path);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    match cwd {
        Some(base) => std::path::Path::new(base).join(p),
        None => p.to_path_buf(),
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::protocol::Request;

    fn handle_line(server: &mut Server, line: &str) -> Response {
        let req: Request = serde_json::from_str(line).expect("parse request");
        let kind = TransportKind::Stdio;
        server.handle(&req, kind)
    }

    fn result_field(resp: &Response, key: &str) -> serde_json::Value {
        resp.result
            .clone()
            .expect("ok result")
            .get(key)
            .cloned()
            .unwrap_or(serde_json::Value::Null)
    }

    #[test]
    fn hello_negotiates_capabilities() {
        let mut server = Server::new();
        let resp = handle_line(
            &mut server,
            r#"{"v":1,"id":1,"method":"hello","params":{"client":"flowdeck","clientVersion":"1.0.3"}}"#,
        );
        assert!(resp.ok);
        let caps = result_field(&resp, "capabilities");
        assert_eq!(caps["protocol"], 1);
        assert_eq!(caps["transport"], "stdio");
        let commands = caps["commands"].as_array().unwrap();
        assert!(commands.iter().any(|c| c == "version"));
        assert!(commands.iter().any(|c| c == "read"));
        assert!(commands.iter().any(|c| c == "ls"));
    }

    #[test]
    fn ping_responds_pong() {
        let mut server = Server::new();
        let resp = handle_line(&mut server, r#"{"v":1,"id":2,"method":"ping"}"#);
        assert!(resp.ok);
        assert_eq!(resp.id, Some(2));
        assert_eq!(result_field(&resp, "pong"), true);
    }

    #[test]
    fn query_version_returns_daemon_version() {
        let mut server = Server::new();
        let resp = handle_line(
            &mut server,
            r#"{"v":1,"id":3,"method":"query","params":{"command":"version","argv":[]}}"#,
        );
        assert!(resp.ok);
        assert_eq!(result_field(&resp, "version"), DAEMON_VERSION);
    }

    #[test]
    fn query_unsupported_returns_error() {
        let mut server = Server::new();
        let resp = handle_line(
            &mut server,
            r#"{"v":1,"id":4,"method":"query","params":{"command":"search","argv":["foo"]}}"#,
        );
        assert!(!resp.ok);
        assert_eq!(resp.error.unwrap().code, err::E_UNSUPPORTED);
    }

    #[test]
    fn query_read_returns_file_lines() {
        let mut server = Server::new();
        // Absolute path so the daemon CWD does not matter.
        let this = concat!(env!("CARGO_MANIFEST_DIR"), "/src/daemon/server.rs");
        let line = format!(
            r#"{{"v":1,"id":5,"method":"query","params":{{"command":"read","argv":["{this}","--limit","3"]}}}}"#
        );
        let resp = handle_line(&mut server, &line);
        assert!(resp.ok, "read failed: {resp:?}");
        let result = result_field(&resp, "result");
        assert!(result["lines"].as_array().unwrap().len() <= 3);
    }

    #[test]
    fn query_read_missing_file_returns_error() {
        let mut server = Server::new();
        let resp = handle_line(
            &mut server,
            r#"{"v":1,"id":6,"method":"query","params":{"command":"read","argv":["/nonexistent/path/xyz.txt"]}}"#,
        );
        assert!(!resp.ok);
        assert_eq!(resp.error.unwrap().code, err::E_INTERNAL);
    }

    #[test]
    fn query_ls_lists_directory() {
        let mut server = Server::new();
        let resp = handle_line(
            &mut server,
            r#"{"v":1,"id":7,"method":"query","params":{"command":"ls","argv":["."]}}"#,
        );
        assert!(resp.ok, "ls failed: {resp:?}");
        let entries = result_field(&resp, "entries");
        let entries = entries.as_array().unwrap();
        assert!(entries.iter().any(|e| e["name"].as_str().is_some()));
    }

    #[test]
    fn capabilities_query_returns_descriptor_registry() {
        let mut server = Server::new();
        let resp = handle_line(
            &mut server,
            r#"{"v":1,"id":8,"method":"query","params":{"command":"capabilities.query","argv":[]}}"#,
        );
        assert!(resp.ok, "capabilities.query failed: {resp:?}");
        let descriptors_value = result_field(&resp, "descriptors");
        let descriptors = descriptors_value.as_array().unwrap();
        assert!(!descriptors.is_empty());
        let first = &descriptors[0];
        assert!(first.get("name").is_some());
        assert!(first.get("readOnly").is_some());
        assert!(first.get("supportsBatching").is_some());
        assert!(first.get("maximumOutputBytes").is_some());
        // Every negotiated command has a descriptor (capabilities parity).
        for command in HOSTED_COMMANDS {
            assert!(
                descriptors.iter().any(|d| d["name"] == command),
                "missing descriptor for negotiated command {command}"
            );
        }
    }

    #[test]
    fn batch_multiplexes_sub_responses() {
        let mut server = Server::new();
        let resp = handle_line(
            &mut server,
            r#"{"v":1,"id":9,"method":"batch","params":{"requests":[
                {"v":1,"id":10,"method":"ping"},
                {"v":1,"id":11,"method":"query","params":{"command":"version","argv":[]}}
            ]}}"#,
        );
        assert!(resp.ok);
        let result = resp.result.clone().unwrap();
        let responses = result["responses"].as_array().unwrap();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["id"], 10);
        assert_eq!(responses[1]["id"], 11);
        assert!(responses[0]["ok"] == true);
        assert!(responses[1]["ok"] == true);
    }

    #[test]
    fn batch_with_invalid_sub_request_reports_error() {
        let mut server = Server::new();
        let resp = handle_line(
            &mut server,
            r#"{"v":1,"id":9,"method":"batch","params":{"requests":[
                {"v":99,"id":10,"method":"ping"}
            ]}}"#,
        );
        assert!(resp.ok);
        let result = resp.result.clone().unwrap();
        let responses = result["responses"].as_array().unwrap();
        assert_eq!(responses.len(), 1);
        assert!(responses[0]["ok"] == false);
        assert_eq!(responses[0]["error"]["code"], err::E_BAD_REQUEST);
    }

    #[test]
    fn typed_batch_dispatches_in_input_order() {
        let mut server = Server::new();
        let tmp = std::env::temp_dir();
        let file = tmp.join("fdx-typed-batch-test.txt");
        std::fs::write(&file, "alpha\nbeta\n").unwrap();
        let file = file.to_string_lossy();
        let line = format!(
            r#"{{"v":1,"id":9,"method":"batch","params":{{"version":1,"cwd":"{}","operations":[
                {{"id":"r1","op":"read","params":{{"file":"{file}","mode":"raw","limit":1}}}},
                {{"id":"r2","op":"read","params":{{"file":"{file}","mode":"raw","limit":1,"offset":2}}}}
            ]}}}}"#,
            tmp.display()
        );
        let resp = handle_line(&mut server, &line);
        assert!(resp.ok, "typed batch failed: {resp:?}");
        let result = resp.result.clone().unwrap();
        assert_eq!(result["version"], 1);
        assert_eq!(result["failedFast"], false);
        let responses = result["responses"].as_array().unwrap();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["id"], "r1");
        assert_eq!(responses[1]["id"], "r2");
        assert!(responses[0]["ok"] == true);
        assert!(responses[1]["ok"] == true);
        let lines1 = responses[0]["result"]["lines"].as_array().unwrap();
        assert_eq!(lines1[0], "alpha");
        let lines2 = responses[1]["result"]["lines"].as_array().unwrap();
        assert_eq!(lines2[0], "beta");
    }

    #[test]
    fn typed_batch_rejects_structural_violations() {
        let mut server = Server::new();
        // Empty operations: rejected whole-batch (E_BAD_REQUEST).
        let resp = handle_line(
            &mut server,
            r#"{"v":1,"id":9,"method":"batch","params":{"version":1,"operations":[]}}"#,
        );
        assert!(!resp.ok);
        assert_eq!(resp.error.unwrap().code, err::E_BAD_REQUEST);

        // Duplicate ids: rejected whole-batch.
        let resp2 = handle_line(
            &mut server,
            r#"{"v":1,"id":9,"method":"batch","params":{"version":1,"operations":[
                {"id":"a","op":"read","params":{"file":"x"}},
                {"id":"a","op":"read","params":{"file":"y"}}
            ]}}"#,
        );
        assert!(!resp2.ok);
        assert_eq!(resp2.error.unwrap().code, err::E_BAD_REQUEST);
    }

    #[test]
    fn cancel_acks_request() {
        let mut server = Server::new();
        // Task 2 executes queries synchronously, so by the time a cancel
        // arrives the request has already completed: the honest ack is
        // "not-in-flight" (real interruption lands with async dispatch in
        // Task 7). The ack event shape is what we verify here.
        let q = handle_line(
            &mut server,
            r#"{"v":1,"id":77,"method":"query","params":{"command":"version","argv":[],"cancelId":77}}"#,
        );
        assert!(q.ok);

        let resp = handle_line(
            &mut server,
            r#"{"v":1,"id":null,"method":"cancel","params":{"targetId":77}}"#,
        );
        assert_eq!(resp.event.as_deref(), Some("cancel-ack"));
        assert_eq!(result_field(&resp, "status"), "not-in-flight");

        // Cancelling an unknown id also reports not-in-flight.
        let resp2 = handle_line(
            &mut server,
            r#"{"v":1,"id":null,"method":"cancel","params":{"targetId":999}}"#,
        );
        assert_eq!(resp2.event.as_deref(), Some("cancel-ack"));
        assert_eq!(result_field(&resp2, "status"), "not-in-flight");
    }

    #[test]
    fn shutdown_responds_ok() {
        let mut server = Server::new();
        let resp = handle_line(&mut server, r#"{"v":1,"id":null,"method":"shutdown"}"#);
        assert!(resp.ok);
        assert_eq!(result_field(&resp, "shuttingDown"), true);
    }

    #[test]
    fn unknown_method_is_rejected_by_validation() {
        // serde with tag "method" will fail to parse an unknown variant, so a
        // malformed request is the wire-level equivalent; handle() only sees
        // validated requests. This test confirms unknown method text fails
        // deserialization (which run() maps to E_BAD_REQUEST).
        let parse =
            serde_json::from_str::<Request>(r#"{"v":1,"id":4,"method":"frobnicate","params":{}}"#);
        assert!(parse.is_err());
    }

    #[test]
    fn resolve_path_joins_against_cwd() {
        let p = resolve_path("src/main.rs", Some("/repo"));
        assert_eq!(p, std::path::Path::new("/repo").join("src/main.rs"));
        let abs = resolve_path("/abs/path", None);
        assert_eq!(abs, std::path::Path::new("/abs/path"));
        let rel = resolve_path("main.rs", None);
        assert_eq!(rel, std::path::Path::new("main.rs"));
    }

    #[test]
    fn hosted_commands_surface_matches_capabilities() {
        // Capability claims must not exceed implemented behaviour. Task 3
        // adds the index commands to the negotiated set; Task 4 adds
        // capabilities.query.
        assert_eq!(
            HOSTED_COMMANDS,
            [
                "version",
                "read",
                "ls",
                "index.status",
                "index.refresh",
                "index.invalidate",
                "index.rebuild",
                "files.query",
                "symbols.query",
                "dependencies.query",
                "testsFor.query",
                "gitState.query",
                "capabilities.query",
            ]
        );
        let mut server = Server::new();
        let resp = handle_line(
            &mut server,
            r#"{"v":1,"id":1,"method":"hello","params":{"client":"c","clientVersion":"1"}}"#,
        );
        let caps = result_field(&resp, "capabilities");
        let commands = caps["commands"].as_array().unwrap();
        assert_eq!(commands.len(), HOSTED_COMMANDS.len());
    }
    #[cfg(unix)]
    mod idle_socket_tests {
        use super::*;
        use crate::daemon::transport::unix_socket;
        use std::io::{Read, Write};
        use std::os::unix::net::{UnixListener, UnixStream};
        use std::time::Duration;

        #[test]
        fn server_run_exits_on_idle_with_attached_client() {
            let dir = std::env::temp_dir();
            let path = dir.join(format!("fdxd-server-idle-{}.sock", std::process::id()));
            let _ = std::fs::remove_file(&path);
            let listener = UnixListener::bind(&path).expect("bind");
            let client = UnixStream::connect(&path).expect("connect");
            let (server_stream, _) = listener.accept().expect("accept");
            let _ = std::fs::remove_file(&path);

            // Spawn the server loop in a thread with a 1s idle timeout.
            let handle = std::thread::spawn(move || {
                let mut server = Server::new();
                let mut t = unix_socket(server_stream);
                let outcome = server.run(&mut t, TransportKind::Unix, Some(Duration::from_secs(1)));
                outcome.map_err(|e| e.to_string())
            });

            // Keep the client ATTACHED but silent — the daemon must exit on
            // idle, not on EOF. The client sends a hello first (matching the
            // real daemon flow), then stays silent for the idle window.
            std::thread::spawn(move || {
                let mut c = client;
                let _ = c.write_all(
                    br#"{"v":1,"id":1,"method":"hello","params":{"client":"flowdeck","clientVersion":"1.0.3"}}"#
                    .as_slice()
                    .as_ref(),
                );
                // Read the hello response, then stay silent.
                let mut buf = [0u8; 4096];
                let _ = c.read(&mut buf);
                std::thread::sleep(Duration::from_secs(3));
            });
            let result = handle
                .join()
                .expect("thread panicked")
                .expect("no transport error");
            assert_eq!(result, RunOutcome::Idle);
        }
    }
}
