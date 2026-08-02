//! Typed read-only batch operations (Task 4).
//!
//! One canonical batch schema across daemon, CLI, TS client, fallback, and
//! capability metadata. The daemon's `batch` method accepts either the
//! legacy multiplexed `requests` (Task 2) or — when `version` + `operations`
//! are present — the typed path implemented here.
//!
//! Contract:
//! - Operations execute in input order; responses map by `id` (input order).
//! - One frozen [`IndexSnapshot`] serves the whole batch (`testsFor` reads it);
//!   `stale_snapshot` is set when the current generation no longer matches.
//! - `fail_fast=false` by default; when true, the batch stops at the first
//!   failed operation and `failed_fast=true`.
//! - A non-read-only or unknown operation tag → per-op `E_UNSUPPORTED`.
//! - Max 64 operations per batch; duplicate ids and empty batches are
//!   rejected structurally.
//! - Read-only only: mutation commands (`index.refresh` & co) are rejected.

pub mod registry;

pub use registry::{
    capabilities_payload, tool_descriptor, tool_descriptors, CachePolicy, LatencyClass,
    ToolDescriptor,
};

use crate::index::{query_tests_for, IndexSnapshot};
use crate::reader::code::cache::AstCache;
use crate::reader::impact::{self, ImpactDirection};
use crate::reader::outline::{self, OutlineOptions};
use crate::reader::search::{self, SearchMatch};
use crate::reader::{read_file, ReadMode, ReaderOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Max operations per batch (contract).
pub const MAX_BATCH_OPS: usize = 64;

/// Error codes used by batch responses (mirror the daemon `err` vocabulary so
/// clients can branch on the same stable codes).
pub mod err {
    pub const E_BAD_REQUEST: &str = "E_BAD_REQUEST";
    pub const E_UNSUPPORTED: &str = "E_UNSUPPORTED";
    pub const E_INTERNAL: &str = "E_INTERNAL";
}

// ─── Wire types ─────────────────────────────────────────────────────────────

/// One typed batch operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOperation {
    /// Client-chosen correlation id, unique within the batch.
    pub id: String,
    /// Operation tag: read | grep | search | outline | impact | testsFor.
    pub op: String,
    /// Operation-specific parameters (all optional; the op tag selects them).
    #[serde(default)]
    pub params: OperationParams,
}

/// Flat parameter bag shared by every operation. Fields are camelCase on the
/// wire and only the ones relevant to the operation tag are read.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationParams {
    // read
    pub file: Option<String>,
    /// auto | raw | prototype | deep (default auto).
    pub mode: Option<String>,
    pub symbol: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,

    // grep
    pub pattern: Option<String>,
    /// Paths to search (files or directories). Defaults to ["."].
    #[serde(default)]
    pub paths: Vec<String>,
    pub context_lines: Option<usize>,
    pub fixed_strings: Option<bool>,
    pub case_sensitive: Option<bool>,

    // search
    pub kind_filter: Option<String>,
    pub max_matches: Option<usize>,
    pub no_cache: Option<bool>,

    // outline
    pub depth: Option<usize>,
    pub min_lines: Option<usize>,

    // impact
    /// Impact target files (mirrors the CLI positional `files`).
    #[serde(default)]
    pub targets: Vec<String>,
    pub direction: Option<String>,
    pub root: Option<String>,

    // testsFor
    /// Source file (repository-relative) to find tests for.
    pub source: Option<String>,
}

/// Per-operation response, mapped in input order.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResponse {
    /// Echoes the operation id.
    pub id: String,
    /// True on success; `error` is set when false.
    pub ok: bool,
    /// Success payload (canonical CLI JSON shape for the operation).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    /// Error payload when `ok` is false.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
}

/// Whole-batch response for the typed path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchResponse {
    /// Batch protocol version echoed back.
    pub version: u32,
    /// Responses in input order.
    pub responses: Vec<OperationResponse>,
    /// True when the batch stopped early because `fail_fast` was set.
    pub failed_fast: bool,
    /// True when the index generation changed while the batch ran (clients
    /// must not persist cache entries derived from this batch's snapshot).
    pub stale_snapshot: bool,
}

/// Structural batch rejection (empty, >64 ops, duplicate ids). Execution
/// errors are per-op; this is a whole-batch refusal.
#[derive(Debug, Clone)]
pub struct BatchReject {
    pub code: &'static str,
    pub message: String,
}

// ─── Index access ───────────────────────────────────────────────────────────

/// Index access the batch executor needs, so tests can substitute a fake and
/// the daemon can pass the shared per-worktree [`crate::index::IndexService`].
pub trait BatchIndexProvider: Send + Sync {
    /// The current frozen snapshot, if one is loaded.
    fn snapshot(&self) -> Option<Arc<IndexSnapshot>>;
    /// The current snapshot, lazily refreshing when none is loaded yet.
    fn ensure_snapshot(&self) -> Option<Arc<IndexSnapshot>>;
}

impl BatchIndexProvider for crate::index::IndexService {
    fn snapshot(&self) -> Option<Arc<IndexSnapshot>> {
        crate::index::IndexService::snapshot(self)
    }

    fn ensure_snapshot(&self) -> Option<Arc<IndexSnapshot>> {
        self.snapshot().or_else(|| self.refresh(false).ok())
    }
}

// ─── Executor ───────────────────────────────────────────────────────────────

/// Execute a typed batch. Validation errors (empty, >64, duplicate ids)
/// return [`Err(BatchReject)`]; per-operation failures become per-op error
/// responses. `index` is only consulted when the batch contains a
/// `testsFor` operation.
pub fn execute_batch(
    operations: &[BatchOperation],
    cwd: Option<&str>,
    index: Option<&dyn BatchIndexProvider>,
    fail_fast: bool,
) -> Result<BatchResponse, BatchReject> {
    if operations.is_empty() {
        return Err(BatchReject {
            code: err::E_BAD_REQUEST,
            message: "batch.operations must not be empty".into(),
        });
    }
    if operations.len() > MAX_BATCH_OPS {
        return Err(BatchReject {
            code: err::E_BAD_REQUEST,
            message: format!("batch.operations exceeds the maximum of {MAX_BATCH_OPS} operations"),
        });
    }
    // Duplicate id rejection: responses map by id, so ids must be unique.
    {
        let mut seen = std::collections::HashSet::new();
        for op in operations {
            if !seen.insert(op.id.as_str()) {
                return Err(BatchReject {
                    code: err::E_BAD_REQUEST,
                    message: format!("duplicate batch operation id '{}'", op.id),
                });
            }
        }
    }

    // One frozen snapshot for the whole batch (only needed by testsFor).
    let needs_index = operations.iter().any(|op| op.op == "testsFor");
    let frozen = if needs_index {
        index.and_then(|i| i.ensure_snapshot())
    } else {
        None
    };

    let cache = AstCache::new();
    let mut responses = Vec::with_capacity(operations.len());
    let mut failed_fast = false;

    for op in operations {
        let resp = run_operation(op, cwd, frozen.as_deref(), &cache);
        let stop = !resp.ok && fail_fast;
        responses.push(resp);
        if stop {
            failed_fast = true;
            break;
        }
    }

    // Stale snapshot: the generation changed while the batch ran, so results
    // derived from `frozen` must not feed cache writes.
    let stale_snapshot = match (&frozen, index) {
        (Some(frozen), Some(idx)) => {
            idx.snapshot().map(|s| s.generation()) != Some(frozen.generation())
        }
        _ => false,
    };

    Ok(BatchResponse {
        version: 1,
        responses,
        failed_fast,
        stale_snapshot,
    })
}

fn run_operation(
    op: &BatchOperation,
    cwd: Option<&str>,
    snapshot: Option<&IndexSnapshot>,
    cache: &AstCache,
) -> OperationResponse {
    let id = op.id.clone();
    // Every batch operation must be read-only and known. `index.*` commands
    // are marked non-read-only in the registry: they are rejected here.
    let descriptor = tool_descriptor(&op.op);
    match descriptor {
        None => {
            return OperationResponse {
                id,
                ok: false,
                result: None,
                error: Some(serde_json::json!({
                    "code": err::E_UNSUPPORTED,
                    "message": format!("unknown batch operation '{}'", op.op),
                })),
            };
        }
        Some(d) if !d.read_only => {
            return OperationResponse {
                id,
                ok: false,
                result: None,
                error: Some(serde_json::json!({
                    "code": err::E_UNSUPPORTED,
                    "message": format!(
                        "operation '{}' is not read-only and cannot run in a batch",
                        op.op
                    ),
                })),
            };
        }
        _ => {}
    }

    let outcome = match op.op.as_str() {
        "read" => op_read(&op.params, cwd, cache),
        "grep" => op_grep(&op.params, cwd),
        "search" => op_search(&op.params, cwd, cache),
        "outline" => op_outline(&op.params, cwd, cache),
        "impact" => op_impact(&op.params, cwd, cache),
        "testsFor" => op_tests_for(&op.params, snapshot),
        other => Err((
            err::E_UNSUPPORTED,
            format!("unknown batch operation '{other}'"),
        )),
    };

    match outcome {
        Ok(value) => OperationResponse {
            id,
            ok: true,
            result: Some(value),
            error: None,
        },
        Err((code, message)) => OperationResponse {
            id,
            ok: false,
            result: None,
            error: Some(serde_json::json!({ "code": code, "message": message })),
        },
    }
}

type OpResult = Result<Value, (&'static str, String)>;

/// `read`: mirrors `fdx read --format json` (CodeResult for code files in
/// prototype/deep mode, TextResult for raw mode and non-code files).
fn op_read(params: &OperationParams, cwd: Option<&str>, cache: &AstCache) -> OpResult {
    let Some(file) = params.file.as_deref() else {
        return Err((err::E_BAD_REQUEST, "read requires 'file'".into()));
    };
    let path = resolve_path(file, cwd);
    let mode = params
        .mode
        .as_deref()
        .unwrap_or("auto")
        .parse::<ReadMode>()
        .map_err(|e| (err::E_BAD_REQUEST, format!("invalid read mode: {e}")))?;
    let options = ReaderOptions {
        mode,
        symbol: params.symbol.clone(),
        limit: params.limit,
        offset: params.offset.unwrap_or(1),
        with_deps: true,
        format: crate::output::OutputFormat::Json,
        no_cache: params.no_cache.unwrap_or(false),
    };
    match read_file(&path, &options, cache) {
        Ok(result) => match result {
            crate::reader::ReadResult::Code(code) => serde_json::to_value(&code).map_err(internal),
            crate::reader::ReadResult::Text(text) => serde_json::to_value(&text).map_err(internal),
        },
        Err(e) => Err((err::E_INTERNAL, format!("read failed: {e}"))),
    }
}

/// `grep`: mirrors `fdx grep --format json` (grep JSON shape).
fn op_grep(params: &OperationParams, cwd: Option<&str>) -> OpResult {
    let Some(pattern) = params.pattern.as_deref() else {
        return Err((err::E_BAD_REQUEST, "grep requires 'pattern'".into()));
    };
    let paths = resolve_paths(&params.paths, cwd);
    let (files, total_matches, truncated) = crate::reader::grep::grep_files(
        pattern,
        &paths,
        params.context_lines.unwrap_or(2),
        params.fixed_strings.unwrap_or(false),
        params.case_sensitive.unwrap_or(false),
        params.max_matches.unwrap_or(50),
    )
    .map_err(|e| (err::E_INTERNAL, format!("grep failed: {e}")))?;

    let files_json: Vec<Value> = files
        .iter()
        .map(|f| {
            serde_json::json!({
                "path": f.path,
                "matches": f.matches.iter().map(|m| serde_json::json!({
                    "line_number": m.line_number,
                    "text": m.text,
                    "context_before": m.context_before,
                    "context_after": m.context_after,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    Ok(serde_json::json!({
        "total_matches": total_matches,
        "truncated": truncated,
        "tee_path": Value::Null,
        "files": files_json,
    }))
}

/// `search`: mirrors `fdx search --format json` (search JSON shape).
fn op_search(params: &OperationParams, cwd: Option<&str>, cache: &AstCache) -> OpResult {
    let Some(pattern) = params.pattern.as_deref() else {
        return Err((err::E_BAD_REQUEST, "search requires 'pattern'".into()));
    };
    let paths = resolve_paths(&params.paths, cwd);
    let kind = params.kind_filter.as_deref().filter(|k| *k != "any");
    let matches: Vec<SearchMatch> = search::search_symbols(
        pattern,
        &paths,
        kind,
        params.max_matches.unwrap_or(50),
        params.no_cache.unwrap_or(false),
        cache,
    )
    .map_err(|e| (err::E_INTERNAL, format!("search failed: {e}")))?;

    Ok(serde_json::json!({
        "pattern": pattern,
        "total_matches": matches.len(),
        "matches": matches.iter().map(|m| serde_json::json!({
            "file": m.path,
            "symbol": m.symbol,
        })).collect::<Vec<_>>(),
    }))
}

/// `outline`: mirrors `fdx outline --format json` (outline JSON shape).
fn op_outline(params: &OperationParams, cwd: Option<&str>, cache: &AstCache) -> OpResult {
    let paths = resolve_paths(&params.paths, cwd);
    let kind_filter = params
        .kind_filter
        .as_deref()
        .map(|k| {
            k.split(',')
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|v| !v.is_empty());
    let options = OutlineOptions {
        depth: params.depth,
        kind_filter,
        min_lines: params.min_lines.unwrap_or(1),
        no_cache: params.no_cache.unwrap_or(false),
    };
    let results = outline::outline_paths(&paths, &options, cache)
        .map_err(|e| (err::E_INTERNAL, format!("outline failed: {e}")))?;

    let total_symbols: usize = results.iter().map(|r| r.symbols.len()).sum();
    let total_lines: usize = results.iter().map(|r| r.total_lines).sum();
    Ok(serde_json::json!({
        "total_files": results.len(),
        "total_symbols": total_symbols,
        "total_lines": total_lines,
        "files": results.iter().map(|r| serde_json::json!({
            "path": r.path,
            "language": r.language,
            "total_lines": r.total_lines,
            "symbols": r.symbols.iter().map(|s| serde_json::json!({
                "kind": s.kind,
                "name": s.name,
                "signature": s.signature,
                "doc_comment": s.doc_comment,
                "line_start": s.line_start,
                "line_end": s.line_end,
            })).collect::<Vec<_>>(),
            "parse_error": r.parse_error,
        })).collect::<Vec<_>>(),
    }))
}

/// `impact`: mirrors `fdx impact --format json` (array of impact results).
fn op_impact(params: &OperationParams, cwd: Option<&str>, cache: &AstCache) -> OpResult {
    let targets = resolve_paths(&params.targets, cwd);
    if targets.is_empty() {
        return Err((
            err::E_BAD_REQUEST,
            "impact requires at least one 'targets' entry".into(),
        ));
    }
    let root = params
        .root
        .as_deref()
        .map(|r| resolve_path(r, cwd))
        .unwrap_or_else(|| cwd.map(PathBuf::from).unwrap_or_else(|| PathBuf::from(".")));
    let direction = params
        .direction
        .as_deref()
        .unwrap_or("both")
        .parse::<ImpactDirection>()
        .map_err(|e| (err::E_BAD_REQUEST, format!("invalid impact direction: {e}")))?;
    let results =
        impact::analyze_impact(&targets, &root, params.depth.unwrap_or(1), direction, cache)
            .map_err(|e| (err::E_INTERNAL, format!("impact failed: {e}")))?;

    serde_json::to_value(
        results
            .iter()
            .map(|r| {
                serde_json::json!({
                    "target": r.target,
                    "depth": r.depth,
                    "outbound": r.outbound.iter().map(|d| serde_json::json!({
                        "path": d.path,
                        "resolved": d.resolved,
                        "symbols_used": if d.symbols_used.is_empty() { Value::Null } else { serde_json::json!(d.symbols_used) },
                        "at_lines": if d.at_lines.is_empty() { Value::Null } else { serde_json::json!(d.at_lines) },
                        "prototypes": d.prototypes,
                    })).collect::<Vec<_>>(),
                    "inbound": r.inbound.iter().map(|d| serde_json::json!({
                        "path": d.path,
                        "resolved": d.resolved,
                        "symbols_used": if d.symbols_used.is_empty() { Value::Null } else { serde_json::json!(d.symbols_used) },
                        "at_lines": if d.at_lines.is_empty() { Value::Null } else { serde_json::json!(d.at_lines) },
                        "prototypes": [],
                    })).collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>(),
    )
    .map_err(internal)
}

/// `testsFor`: reads the frozen batch snapshot (no per-op refresh — the
/// whole batch observes one generation).
fn op_tests_for(params: &OperationParams, snapshot: Option<&IndexSnapshot>) -> OpResult {
    let Some(source) = params.source.as_deref() else {
        return Err((err::E_BAD_REQUEST, "testsFor requires 'source'".into()));
    };
    let Some(snap) = snapshot else {
        return Err((
            err::E_INTERNAL,
            "testsFor requires an index snapshot; run index.refresh first".into(),
        ));
    };
    let rows = query_tests_for(snap, source);
    serde_json::to_value(&rows).map_err(internal)
}

// ─── Path helpers ───────────────────────────────────────────────────────────

/// Resolve one (possibly relative) path against the batch cwd.
fn resolve_path(path: &str, cwd: Option<&str>) -> PathBuf {
    let p = Path::new(path);
    if p.is_absolute() {
        return p.to_path_buf();
    }
    match cwd {
        Some(base) => Path::new(base).join(p),
        None => p.to_path_buf(),
    }
}

/// Resolve a list of paths; empty lists default to ["."] (the batch cwd).
fn resolve_paths(paths: &[String], cwd: Option<&str>) -> Vec<PathBuf> {
    if paths.is_empty() {
        return vec![cwd.map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))];
    }
    paths.iter().map(|p| resolve_path(p, cwd)).collect()
}

fn internal(e: serde_json::Error) -> (&'static str, String) {
    (err::E_INTERNAL, format!("serialization failed: {e}"))
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn op(id: &str, tag: &str, params: serde_json::Value) -> BatchOperation {
        BatchOperation {
            id: id.to_string(),
            op: tag.to_string(),
            params: serde_json::from_value(params).expect("params parse"),
        }
    }

    fn ok_result(resp: &OperationResponse) -> Value {
        resp.result.clone().expect("ok result")
    }

    #[test]
    fn empty_batch_is_rejected() {
        let err = execute_batch(&[], None, None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("must not be empty"));
    }

    #[test]
    fn over_capacity_batch_is_rejected() {
        let ops: Vec<BatchOperation> = (0..=MAX_BATCH_OPS)
            .map(|i| op(&format!("{i}"), "read", serde_json::json!({})))
            .collect();
        let err = execute_batch(&ops, None, None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("maximum of"));
    }

    #[test]
    fn duplicate_ids_are_rejected() {
        let ops = vec![
            op("a", "read", serde_json::json!({})),
            op("a", "read", serde_json::json!({})),
        ];
        let err = execute_batch(&ops, None, None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("duplicate"));
    }

    #[test]
    fn unknown_and_mutating_ops_are_unsupported_per_op() {
        let ops = vec![
            op("1", "frobnicate", serde_json::json!({})),
            op("2", "index.refresh", serde_json::json!({})),
        ];
        let resp = execute_batch(&ops, None, None, false).unwrap();
        assert!(!resp.failed_fast);
        assert!(!resp.responses[0].ok);
        assert_eq!(
            resp.responses[0].error.as_ref().unwrap()["code"],
            err::E_UNSUPPORTED
        );
        assert!(!resp.responses[1].ok);
        assert_eq!(
            resp.responses[1].error.as_ref().unwrap()["code"],
            err::E_UNSUPPORTED
        );
    }

    #[test]
    fn read_raw_returns_text_result() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "line1\nline2\nline3\n").unwrap();
        let ops = vec![op(
            "r1",
            "read",
            serde_json::json!({ "file": "a.txt", "mode": "raw" }),
        )];
        let resp = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap();
        let result = ok_result(&resp.responses[0]);
        assert_eq!(result["mode"], "raw");
        assert_eq!(result["total_lines"], 3);
        assert_eq!(result["lines"][0], "line1");
    }

    #[test]
    fn grep_returns_matching_lines() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("a.txt"),
            "hello world\nnothing here\nhello again\n",
        )
        .unwrap();
        let ops = vec![op(
            "g1",
            "grep",
            serde_json::json!({ "pattern": "hello", "paths": ["."] }),
        )];
        let resp = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap();
        let result = ok_result(&resp.responses[0]);
        assert_eq!(result["total_matches"], 2);
        assert_eq!(result["files"][0]["matches"][0]["line_number"], 1);
    }

    #[test]
    fn search_finds_symbols() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("lib.ts"),
            "export function greet(): string { return \"hi\" }\n",
        )
        .unwrap();
        let ops = vec![op(
            "s1",
            "search",
            serde_json::json!({ "pattern": "greet", "paths": ["."] }),
        )];
        let resp = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap();
        let result = ok_result(&resp.responses[0]);
        assert_eq!(result["total_matches"], 1);
        assert_eq!(result["matches"][0]["symbol"]["name"], "greet");
    }

    #[test]
    fn outline_lists_symbols() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("lib.ts"),
            "export function greet(): string { return \"hi\" }\nexport class Widget {}\n",
        )
        .unwrap();
        let ops = vec![op("o1", "outline", serde_json::json!({ "paths": ["."] }))];
        let resp = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap();
        let result = ok_result(&resp.responses[0]);
        assert_eq!(result["total_files"], 1);
        assert_eq!(result["total_symbols"], 2);
        assert_eq!(result["files"][0]["symbols"][0]["name"], "greet");
    }

    #[test]
    fn fail_fast_stops_at_first_failure() {
        let tmp = tempfile::tempdir().unwrap();
        let ops = vec![
            op("1", "read", serde_json::json!({ "file": "missing.txt" })),
            op(
                "2",
                "read",
                serde_json::json!({ "file": "also-missing.txt" }),
            ),
        ];
        let resp = execute_batch(&ops, tmp.path().to_str(), None, true).unwrap();
        assert!(resp.failed_fast);
        assert_eq!(resp.responses.len(), 1, "stops after first failure");
    }

    #[test]
    fn fail_fast_false_runs_all_ops() {
        let tmp = tempfile::tempdir().unwrap();
        let ops = vec![
            op("1", "read", serde_json::json!({ "file": "missing.txt" })),
            op(
                "2",
                "read",
                serde_json::json!({ "file": "also-missing.txt" }),
            ),
        ];
        let resp = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap();
        assert!(!resp.failed_fast);
        assert_eq!(resp.responses.len(), 2, "runs every op in input order");
        assert!(!resp.responses[0].ok);
        assert!(!resp.responses[1].ok);
    }

    #[test]
    fn stale_snapshot_is_false_without_index() {
        let ops = vec![op("1", "grep", serde_json::json!({ "pattern": "x" }))];
        let resp = execute_batch(&ops, None, None, false).unwrap();
        assert!(!resp.stale_snapshot);
    }
}
