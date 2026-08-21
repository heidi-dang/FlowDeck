//! Persistent resident FDX engine — JSON-lines protocol over stdin/stdout.
//!
//! One long-lived process per repository serves many read/search/outline/impact
//! requests across a persistent IPC channel (stdin/stdout), avoiding one
//! process spawn per request. Read-only only: this daemon never executes
//! mutating operations and is never an authority for dangerous execution.
//!
//! Protocol:
//!   request:  {"id":"<reqid>","op":"version|health|read|search|outline|impact","args":{...}}
//!   response: {"id":"<reqid>","ok":true,"value":...}
//!   response: {"id":"<reqid>","ok":false,"error":"..."}
//! Newline-delimited JSON, one object per line.

use std::io::BufRead;
use std::path::PathBuf;
use std::sync::mpsc::sync_channel;
use std::sync::Arc;
use std::thread;

use serde::{Deserialize, Serialize};

use crate::reader::code::cache::AstCache;
use crate::reader::impact::{self, ImpactDirection};
use crate::reader::outline::{self, OutlineOptions};
use crate::reader::search;
use crate::reader::{read_file, ReadMode, ReaderOptions};

#[derive(Debug, Deserialize)]
struct ServeRequest {
    id: String,
    #[serde(rename = "op")]
    op: String,
    #[serde(default)]
    args: serde_json::Value,
}

#[derive(Serialize)]
struct ServeResponse<'a> {
    id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

const MAX_REQUEST_BYTES: usize = 256 * 1024;
const NUM_WORKERS: usize = 4;
const MAX_QUEUED_REQUESTS: usize = 128;

fn format_reply(
    id: &str,
    ok: bool,
    value: Option<serde_json::Value>,
    error: Option<String>,
) -> Option<String> {
    let resp = ServeResponse {
        id,
        ok,
        value,
        error,
    };
    serde_json::to_string(&resp).ok().map(|mut s| {
        s.push('\n');
        s
    })
}

fn format_ok(id: &str, value: serde_json::Value) -> Option<String> {
    format_reply(id, true, Some(value), None)
}

fn format_err(id: &str, message: String) -> Option<String> {
    format_reply(id, false, None, Some(message))
}

fn read_args(args: &serde_json::Value) -> Result<(PathBuf, Option<usize>, Option<usize>), String> {
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "read: missing path".to_string())?;
    let offset = args
        .get("offset")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize);
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize);
    Ok((PathBuf::from(path), offset, limit))
}

fn parse_paths(args: &serde_json::Value) -> Vec<PathBuf> {
    args.get("paths")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
}

fn handle_read(id: &str, args: &serde_json::Value, cache: &AstCache) -> Option<String> {
    let (path, offset, limit) = match read_args(args) {
        Ok(v) => v,
        Err(e) => return format_err(id, e),
    };
    let options = ReaderOptions {
        mode: ReadMode::Auto,
        symbol: None,
        limit,
        offset: offset.unwrap_or(1),
        with_deps: false,
        format: crate::output::OutputFormat::Text,
        no_cache: false,
    };
    match read_file(&path, &options, cache) {
        Ok(result) => {
            let mut buffer: Vec<u8> = Vec::new();
            let rendered = match result {
                crate::reader::ReadResult::Code(code) => {
                    use crate::output::text;
                    let _ = text::print_text_output(
                        &mut buffer,
                        &code.path,
                        &code.language,
                        &code.mode,
                        code.total_lines,
                        &code.symbols,
                        code.parse_error.as_deref(),
                    );
                    String::from_utf8_lossy(&buffer).to_string()
                }
                crate::reader::ReadResult::Text(text) => {
                    use crate::output::text;
                    let _ = text::print_text_result(&mut buffer, &text.path, &text);
                    String::from_utf8_lossy(&buffer).to_string()
                }
            };
            format_ok(
                id,
                serde_json::json!({ "path": path.to_string_lossy(), "text": rendered }),
            )
        }
        Err(e) => format_err(id, format!("read error: {}", e)),
    }
}

fn handle_search(id: &str, args: &serde_json::Value, cache: &AstCache) -> Option<String> {
    let pattern = match args.get("pattern").and_then(|v| v.as_str()) {
        Some(p) if !p.is_empty() => p,
        _ => return format_err(id, "search: missing pattern".to_string()),
    };
    let mut paths = parse_paths(args);
    if paths.is_empty() {
        if let Some(p) = args.get("path").and_then(|v| v.as_str()) {
            paths.push(PathBuf::from(p));
        }
    }
    if paths.is_empty() {
        paths.push(PathBuf::from("."));
    }
    let kind = args
        .get("kind")
        .and_then(|v| v.as_str())
        .filter(|k| *k != "any");
    let max_matches = args
        .get("max_matches")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(50);
    match search::search_symbols(pattern, &paths, kind, max_matches, false, cache) {
        Ok(matches) => {
            let value: Vec<serde_json::Value> = matches
                .iter()
                .map(|m| serde_json::json!({ "path": m.path, "symbol": m.symbol }))
                .collect();
            format_ok(id, serde_json::json!(value))
        }
        Err(e) => format_err(id, format!("search error: {}", e)),
    }
}

fn handle_outline(id: &str, args: &serde_json::Value, cache: &AstCache) -> Option<String> {
    let paths = parse_paths(args);
    if paths.is_empty() {
        return format_err(id, "outline: missing paths".to_string());
    }
    let options = OutlineOptions {
        depth: args
            .get("depth")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize),
        kind_filter: args
            .get("kind")
            .and_then(|v| v.as_str())
            .map(|s| s.split(',').map(String::from).collect()),
        min_lines: args
            .get("min_lines")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(1),
        no_cache: false,
    };
    match outline::outline_paths(&paths, &options, cache) {
        Ok(results) => {
            let value: Vec<serde_json::Value> = results
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "path": r.path,
                        "language": r.language,
                        "total_lines": r.total_lines,
                        "symbols": r.symbols,
                        "parse_error": r.parse_error
                    })
                })
                .collect();
            format_ok(id, serde_json::json!(value))
        }
        Err(e) => format_err(id, format!("outline error: {}", e)),
    }
}

fn handle_impact(id: &str, args: &serde_json::Value, cache: &AstCache) -> Option<String> {
    let targets = parse_paths(args);
    if targets.is_empty() {
        return format_err(id, "impact: missing files".to_string());
    }
    let root = args
        .get("root")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let depth = args
        .get("depth")
        .and_then(|v| v.as_u64())
        .map(|v| v as usize)
        .unwrap_or(1);
    let direction = match args.get("direction").and_then(|v| v.as_str()) {
        Some("in") => ImpactDirection::In,
        Some("out") => ImpactDirection::Out,
        _ => ImpactDirection::Both,
    };
    match impact::analyze_impact(&targets, &root, depth, direction, cache) {
        Ok(results) => {
            let value: Vec<serde_json::Value> = results
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "target": r.target,
                        "depth": r.depth,
                        "outbound": r.outbound,
                        "inbound": r.inbound
                    })
                })
                .collect();
            format_ok(id, serde_json::json!(value))
        }
        Err(e) => format_err(id, format!("impact error: {}", e)),
    }
}

fn process_request(req: ServeRequest, cache: &AstCache) -> Option<String> {
    match req.op.as_str() {
        "version" => format_ok(
            &req.id,
            serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }),
        ),
        "health" => format_ok(
            &req.id,
            serde_json::json!({ "healthy": true, "service": "fdx-native-daemon" }),
        ),
        "read" => handle_read(&req.id, &req.args, cache),
        "search" => handle_search(&req.id, &req.args, cache),
        "outline" => handle_outline(&req.id, &req.args, cache),
        "impact" => handle_impact(&req.id, &req.args, cache),
        other => format_err(&req.id, format!("FDX_METHOD_NOT_ALLOWED {}", other)),
    }
}

/// Run the resident server loop. Reads newline-delimited JSON from stdin and
/// writes responses to stdout until EOF using a bounded worker pool.
pub fn run() {
    let stdin = std::io::stdin();
    let mut reader = std::io::BufReader::new(stdin.lock());
    let (resp_tx, resp_rx) = sync_channel::<String>(MAX_QUEUED_REQUESTS);
    let (req_tx, req_rx) = sync_channel::<ServeRequest>(MAX_QUEUED_REQUESTS);
    let req_rx = Arc::new(std::sync::Mutex::new(req_rx));
    let cache = Arc::new(AstCache::new());

    // Dedicated stdout writer thread to serialize response lines
    let writer_handle = thread::spawn(move || {
        use std::io::Write;
        let stdout = std::io::stdout();
        let mut out = stdout.lock();
        while let Ok(msg) = resp_rx.recv() {
            let _ = out.write_all(msg.as_bytes());
            let _ = out.flush();
        }
    });

    // Bounded concurrent worker pool
    let mut workers = Vec::with_capacity(NUM_WORKERS);
    for _ in 0..NUM_WORKERS {
        let req_rx_clone = Arc::clone(&req_rx);
        let resp_tx_clone = resp_tx.clone();
        let cache_clone = Arc::clone(&cache);
        let handle = thread::spawn(move || {
            loop {
                let req = {
                    let lock = req_rx_clone.lock().ok();
                    match lock {
                        Some(rx) => match rx.recv() {
                            Ok(r) => r,
                            Err(_) => break, // Request sender closed
                        },
                        None => break,
                    }
                };
                if let Some(resp) = process_request(req, &cache_clone) {
                    if resp_tx_clone.send(resp).is_err() {
                        break;
                    }
                }
            }
        });
        workers.push(handle);
    }
    drop(resp_tx); // Drop initial sender clone so only worker senders remain

    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break, // EOF — parent closed pipe
            Ok(n) => {
                if n > MAX_REQUEST_BYTES {
                    continue;
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(req) = serde_json::from_str::<ServeRequest>(trimmed) {
                    if req_tx.send(req).is_err() {
                        break;
                    }
                }
            }
            Err(_) => break,
        }
    }

    drop(req_tx); // Signals workers to finish
    for w in workers {
        let _ = w.join();
    }
    let _ = writer_handle.join();
}
