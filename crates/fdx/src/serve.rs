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
use std::path::{Component, Path, PathBuf};
use std::sync::mpsc::sync_channel;
use std::sync::Arc;
use std::thread;

use serde::{Deserialize, Serialize};

use crate::protocol::{NegotiateRequest, NegotiateResponse, FDX_PROTOCOL_VERSION};
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

/// Safely resolves and checks that `user_path` is strictly contained inside `canonical_root`.
pub fn resolve_contained_path(
    canonical_root: &Path,
    user_path: &Path,
    must_exist: bool,
) -> Result<PathBuf, String> {
    let raw_str = user_path.to_string_lossy();
    if raw_str.is_empty() {
        return Err("path cannot be empty".to_string());
    }
    if raw_str.contains('\0') {
        return Err("path contains NUL byte".to_string());
    }

    // Windows UNC / raw drive escape checks
    if raw_str.starts_with(r"\\") || raw_str.starts_with("//") {
        return Err(format!("UNC paths are not permitted: {}", raw_str));
    }

    // Candidate path constructed relative to canonical root if relative, or taken as-is if absolute
    let candidate = if user_path.is_absolute() {
        user_path.to_path_buf()
    } else {
        // Normalize any Windows-style backslashes on non-Windows systems if present
        let normalized = raw_str.replace('\\', "/");
        canonical_root.join(normalized)
    };

    if candidate.exists() {
        let canonical = match std::fs::canonicalize(&candidate) {
            Ok(c) => c,
            Err(e) => return Err(format!("failed to canonicalize path: {}", e)),
        };

        if !canonical.starts_with(canonical_root) {
            return Err(format!(
                "security error: path {:?} escapes repository root {:?}",
                user_path, canonical_root
            ));
        }
        return Ok(canonical);
    }

    if must_exist {
        return Err(format!("file not found: {:?}", user_path));
    }

    // For non-existent files: lexical component check
    let mut depth: isize = 0;
    for c in user_path.components() {
        match c {
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 && !user_path.is_absolute() {
                    return Err(format!(
                        "security error: path {:?} escapes repository root",
                        user_path
                    ));
                }
            }
            Component::Normal(_) => {
                depth += 1;
            }
            Component::RootDir | Component::Prefix(_) => {
                // Absolute path: must check against canonical root
            }
            _ => {}
        }
    }

    // Check closest existing ancestor for symlink escapes
    let mut ancestor = candidate.as_path();
    while !ancestor.exists() {
        if let Some(parent) = ancestor.parent() {
            ancestor = parent;
        } else {
            break;
        }
    }

    if ancestor.exists() {
        if let Ok(canonical_ancestor) = std::fs::canonicalize(ancestor) {
            if !canonical_ancestor.starts_with(canonical_root) {
                return Err("security error: ancestor path escapes repository root".to_string());
            }
        }
    }

    if candidate.is_absolute() && !candidate.starts_with(canonical_root) {
        return Err(format!(
            "security error: absolute path {:?} escapes repository root {:?}",
            user_path, canonical_root
        ));
    }

    Ok(candidate)
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

fn handle_read(
    id: &str,
    args: &serde_json::Value,
    cache: &AstCache,
    root: &Path,
) -> Option<String> {
    let (raw_path, offset, limit) = match read_args(args) {
        Ok(v) => v,
        Err(e) => return format_err(id, e),
    };
    let path = match resolve_contained_path(root, &raw_path, true) {
        Ok(p) => p,
        Err(e) => return format_err(id, format!("read error: {}", e)),
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

fn handle_search(
    id: &str,
    args: &serde_json::Value,
    cache: &AstCache,
    root: &Path,
) -> Option<String> {
    let pattern = match args.get("pattern").and_then(|v| v.as_str()) {
        Some(p) if !p.is_empty() => p,
        _ => return format_err(id, "search: missing pattern".to_string()),
    };
    let mut raw_paths = parse_paths(args);
    if raw_paths.is_empty() {
        if let Some(p) = args.get("path").and_then(|v| v.as_str()) {
            raw_paths.push(PathBuf::from(p));
        }
    }
    if raw_paths.is_empty() {
        raw_paths.push(PathBuf::from("."));
    }

    let mut paths = Vec::with_capacity(raw_paths.len());
    for p in raw_paths {
        match resolve_contained_path(root, &p, false) {
            Ok(cp) => paths.push(cp),
            Err(e) => return format_err(id, format!("search error: {}", e)),
        }
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

fn handle_outline(
    id: &str,
    args: &serde_json::Value,
    cache: &AstCache,
    root: &Path,
) -> Option<String> {
    let raw_paths = parse_paths(args);
    if raw_paths.is_empty() {
        return format_err(id, "outline: missing paths".to_string());
    }

    let mut paths = Vec::with_capacity(raw_paths.len());
    for p in raw_paths {
        match resolve_contained_path(root, &p, false) {
            Ok(cp) => paths.push(cp),
            Err(e) => return format_err(id, format!("outline error: {}", e)),
        }
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

fn handle_impact(
    id: &str,
    args: &serde_json::Value,
    cache: &AstCache,
    root: &Path,
) -> Option<String> {
    let raw_targets = parse_paths(args);
    if raw_targets.is_empty() {
        return format_err(id, "impact: missing files".to_string());
    }

    let mut targets = Vec::with_capacity(raw_targets.len());
    for t in raw_targets {
        match resolve_contained_path(root, &t, false) {
            Ok(ct) => targets.push(ct),
            Err(e) => return format_err(id, format!("impact error: {}", e)),
        }
    }

    // Enforce authoritative repository root; do not allow caller to bypass root
    let impact_root = match args.get("root").and_then(|v| v.as_str()) {
        Some(r) => match resolve_contained_path(root, Path::new(r), false) {
            Ok(cr) => cr,
            Err(e) => return format_err(id, format!("impact error: {}", e)),
        },
        None => root.to_path_buf(),
    };

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
    match impact::analyze_impact(&targets, &impact_root, depth, direction, cache) {
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

fn handle_evidence_graph_v1(
    id: &str,
    _args: &serde_json::Value,
    _cache: &AstCache,
    root: &Path,
) -> Option<String> {
    let db_result = crate::intelligence::db::EvidenceDatabase::open(
        root,
        crate::intelligence::db::DatabaseOpenMode::ReadOnly,
    );
    let db_ref = match &db_result {
        Ok(db) => Ok(db),
        Err(e) => Err(e),
    };

    // Same production status evaluator used by `fdx index status`.
    let report = crate::intelligence::status::evaluate_index_status(
        root,
        db_ref,
        &crate::protocol::GraphCompatibility::default(),
    );

    format_ok(
        id,
        serde_json::json!({
            "status": report.state,
            "reasons": report.reasons,
            "generation": report.generation,
            "schema_version": report.schema_version,
            "files": report.files,
            "nodes": report.nodes,
            "edges": report.edges,
            "journal_mode": report.journal_mode,
            "foreign_keys": report.foreign_keys,
            "busy_timeout": report.busy_timeout,
        }),
    )
}

fn handle_semantic_status_v1(
    id: &str,
    _args: &serde_json::Value,
    _cache: &AstCache,
    root: &Path,
) -> Option<String> {
    // Read-only provider diagnostics: consumes already-persisted semantic
    // evidence only. The daemon never executes providers.
    let db = match crate::intelligence::db::EvidenceDatabase::open(
        root,
        crate::intelligence::db::DatabaseOpenMode::ReadOnly,
    ) {
        Ok(d) => d,
        Err(crate::intelligence::db::DatabaseError::NotIndexed) => {
            return format_ok(
                id,
                serde_json::json!({
                    "providers": [],
                    "semantic_nodes": 0,
                    "semantic_edges": 0,
                    "status": "absent",
                }),
            );
        }
        Err(e) => return format_err(id, format!("semantic status error: {}", e)),
    };
    let states = match crate::intelligence::semantic::state::load_provider_states(&db) {
        Ok(s) => s,
        Err(e) => return format_err(id, format!("semantic status error: {}", e)),
    };
    let (nodes, edges) = match crate::intelligence::semantic::state::count_semantic_evidence(&db) {
        Ok(n) => n,
        Err(_) => (0, 0),
    };
    let providers: Vec<serde_json::Value> = states
        .iter()
        .map(|s| {
            serde_json::json!({
                "provider": s.provider_id(),
                "type": s.identity.provider_type.as_str(),
                "version": s.identity.provider_version,
                "health": s.health.as_str(),
                "freshness": s.freshness.as_str(),
                "fingerprint": s.fingerprint.digest,
                "scope_root": s.scope.workspace_root,
                "scope_package": s.scope.package,
                "last_success": s.last_successful_run,
                "generation": s.semantic_generation,
                "reason": s.failure_reason,
            })
        })
        .collect();
    format_ok(
        id,
        serde_json::json!({
            "providers": providers,
            "semantic_nodes": nodes,
            "semantic_edges": edges,
            "status": "ok",
        }),
    )
}

fn process_request(req: ServeRequest, cache: &AstCache, root: &Path) -> Option<String> {
    match req.op.as_str() {
        "version" => format_ok(
            &req.id,
            serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }),
        ),
        "health" => format_ok(
            &req.id,
            serde_json::json!({ "healthy": true, "service": "fdx-native-daemon" }),
        ),
        "negotiate" => {
            let neg_req: NegotiateRequest =
                serde_json::from_value(req.args).unwrap_or(NegotiateRequest {
                    protocol: FDX_PROTOCOL_VERSION,
                    capabilities: Vec::new(),
                });
            let resp = NegotiateResponse::negotiate(&neg_req);
            match serde_json::to_value(&resp) {
                Ok(val) => format_ok(&req.id, val),
                Err(e) => format_err(&req.id, format!("negotiate serialization error: {}", e)),
            }
        }
        "capabilities" => {
            let resp = NegotiateResponse::negotiate(&NegotiateRequest {
                protocol: FDX_PROTOCOL_VERSION,
                capabilities: Vec::new(),
            });
            match serde_json::to_value(&resp) {
                Ok(val) => format_ok(&req.id, val),
                Err(e) => format_err(&req.id, format!("capabilities serialization error: {}", e)),
            }
        }
        "read" => handle_read(&req.id, &req.args, cache, root),
        "search" => handle_search(&req.id, &req.args, cache, root),
        "outline" => handle_outline(&req.id, &req.args, cache, root),
        "impact" => handle_impact(&req.id, &req.args, cache, root),
        "evidence-graph-v1" => handle_evidence_graph_v1(&req.id, &req.args, cache, root),
        "semantic-status-v1" => handle_semantic_status_v1(&req.id, &req.args, cache, root),
        other => format_err(&req.id, format!("FDX_METHOD_NOT_ALLOWED {}", other)),
    }
}

/// Run the resident server loop. Reads newline-delimited JSON from stdin and
/// writes responses to stdout until EOF using a bounded worker pool.
pub fn run(root_opt: Option<PathBuf>) {
    let raw_root = root_opt.unwrap_or_else(|| PathBuf::from("."));
    let canonical_root = match std::fs::canonicalize(&raw_root) {
        Ok(p) => p,
        Err(_) => std::env::current_dir().unwrap_or(raw_root),
    };
    let root = Arc::new(canonical_root);

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
        let root_clone = Arc::clone(&root);
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
                if let Some(resp) = process_request(req, &cache_clone, &root_clone) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn test_resolve_contained_path_success() {
        let dir = tempdir().unwrap();
        let canonical_root = fs::canonicalize(dir.path()).unwrap();
        let file_path = canonical_root.join("hello.txt");
        let mut f = File::create(&file_path).unwrap();
        writeln!(f, "hello world").unwrap();

        let resolved =
            resolve_contained_path(&canonical_root, Path::new("hello.txt"), true).unwrap();
        assert_eq!(resolved, file_path);
    }

    #[test]
    fn test_resolve_contained_path_rejects_escape() {
        let dir = tempdir().unwrap();
        let canonical_root = fs::canonicalize(dir.path()).unwrap();

        assert!(resolve_contained_path(&canonical_root, Path::new("../outside"), false).is_err());
        assert!(
            resolve_contained_path(&canonical_root, Path::new("../../outside"), false).is_err()
        );
        assert!(
            resolve_contained_path(&canonical_root, Path::new("a/../../../../outside"), false)
                .is_err()
        );
        assert!(resolve_contained_path(&canonical_root, Path::new("/etc/passwd"), false).is_err());
    }

    #[test]
    fn test_resolve_contained_path_symlink_escape() {
        let repo_dir = tempdir().unwrap();
        let outside_dir = tempdir().unwrap();

        let canonical_root = fs::canonicalize(repo_dir.path()).unwrap();
        let canonical_outside = fs::canonicalize(outside_dir.path()).unwrap();

        let outside_secret = canonical_outside.join("secret.txt");
        File::create(&outside_secret).unwrap();

        let symlink_path = canonical_root.join("symlink_to_outside.txt");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside_secret, &symlink_path).unwrap();
            assert!(resolve_contained_path(
                &canonical_root,
                Path::new("symlink_to_outside.txt"),
                true
            )
            .is_err());
        }
    }
}
