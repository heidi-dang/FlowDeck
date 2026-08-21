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

use std::io::{BufRead, Write};
use std::path::PathBuf;

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

fn reply(
    writer: &mut dyn Write,
    id: &str,
    ok: bool,
    value: Option<serde_json::Value>,
    error: Option<String>,
) {
    let resp = ServeResponse {
        id,
        ok,
        value,
        error,
    };
    if let Ok(line) = serde_json::to_string(&resp) {
        let mut out = line;
        out.push('\n');
        let _ = writer.write_all(out.as_bytes());
        let _ = writer.flush();
    }
}

fn ok_value(writer: &mut dyn Write, id: &str, value: serde_json::Value) {
    reply(writer, id, true, Some(value), None);
}

fn err(writer: &mut dyn Write, id: &str, message: String) {
    reply(writer, id, false, None, Some(message));
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

fn handle_read(writer: &mut dyn Write, id: &str, args: &serde_json::Value, cache: &AstCache) {
    let (path, offset, limit) = match read_args(args) {
        Ok(v) => v,
        Err(e) => return err(writer, id, e),
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
            // Render a stable textual representation for the replay/tool layer.
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
            ok_value(
                writer,
                id,
                serde_json::json!({ "path": path.to_string_lossy(), "text": rendered }),
            );
        }
        Err(e) => err(writer, id, format!("read error: {}", e)),
    }
}

fn handle_search(writer: &mut dyn Write, id: &str, args: &serde_json::Value, cache: &AstCache) {
    let pattern = match args.get("pattern").and_then(|v| v.as_str()) {
        Some(p) if !p.is_empty() => p,
        _ => return err(writer, id, "search: missing pattern".to_string()),
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
            ok_value(writer, id, serde_json::json!(value));
        }
        Err(e) => err(writer, id, format!("search error: {}", e)),
    }
}

fn handle_outline(writer: &mut dyn Write, id: &str, args: &serde_json::Value, cache: &AstCache) {
    let paths = parse_paths(args);
    if paths.is_empty() {
        return err(writer, id, "outline: missing paths".to_string());
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
            let value: Vec<serde_json::Value> = results.iter().map(|r| serde_json::json!({ "path": r.path, "language": r.language, "total_lines": r.total_lines, "symbols": r.symbols, "parse_error": r.parse_error })).collect();
            ok_value(writer, id, serde_json::json!(value));
        }
        Err(e) => err(writer, id, format!("outline error: {}", e)),
    }
}

fn handle_impact(writer: &mut dyn Write, id: &str, args: &serde_json::Value, cache: &AstCache) {
    let targets = parse_paths(args);
    if targets.is_empty() {
        return err(writer, id, "impact: missing files".to_string());
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
            let value: Vec<serde_json::Value> = results.iter().map(|r| serde_json::json!({ "target": r.target, "depth": r.depth, "outbound": r.outbound, "inbound": r.inbound })).collect();
            ok_value(writer, id, serde_json::json!(value));
        }
        Err(e) => err(writer, id, format!("impact error: {}", e)),
    }
}

/// Run the resident server loop. Reads newline-delimited JSON from stdin and
/// writes responses to stdout until EOF.
pub fn run() {
    let stdin = std::io::stdin();
    let mut reader = std::io::BufReader::new(stdin.lock());
    let mut stdout = std::io::stdout();
    let mut line = String::new();
    let cache = AstCache::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) => break, // EOF — parent closed the pipe
            Ok(n) => {
                if n > MAX_REQUEST_BYTES {
                    err(&mut stdout, "unknown", "FDX_REQUEST_LIMIT".to_string());
                    continue;
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let req: ServeRequest = match serde_json::from_str(trimmed) {
                    Ok(r) => r,
                    Err(e) => {
                        err(&mut stdout, "unknown", format!("FDX_INVALID_REQUEST {}", e));
                        continue;
                    }
                };
                match req.op.as_str() {
                    "version" => ok_value(
                        &mut stdout,
                        &req.id,
                        serde_json::json!({ "version": env!("CARGO_PKG_VERSION") }),
                    ),
                    "health" => ok_value(
                        &mut stdout,
                        &req.id,
                        serde_json::json!({ "healthy": true, "service": "fdx-native-daemon" }),
                    ),
                    "read" => handle_read(&mut stdout, &req.id, &req.args, &cache),
                    "search" => handle_search(&mut stdout, &req.id, &req.args, &cache),
                    "outline" => handle_outline(&mut stdout, &req.id, &req.args, &cache),
                    "impact" => handle_impact(&mut stdout, &req.id, &req.args, &cache),
                    other => err(
                        &mut stdout,
                        &req.id,
                        format!("FDX_METHOD_NOT_ALLOWED {}", other),
                    ),
                }
            }
            Err(e) => {
                err(&mut stdout, "unknown", format!("FDX_IO_ERROR {}", e));
                break;
            }
        }
    }
}
