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
//! - Results of Repository-cacheable ops (all six batch ops) are served from
//!   and stored in the content-addressed query cache (Dev 3 Task 4 Phase 3)
//!   under the worktree state dir, keyed by repository/worktree state. Cache
//!   writes are skipped when the batch snapshot is stale.

pub mod registry;

pub use registry::{
    capabilities_payload, tool_descriptor, tool_descriptors, CachePolicy, LatencyClass,
    ToolDescriptor,
};

use crate::index::identity::{
    config_hash, dirty_fingerprint, discover_identity, fdx_version, git_head_sha, ignore_hash,
};
use crate::index::paths::{index_state_root, worktree_dir};
use crate::index::query_cache::{
    canonical_json, configuration_fingerprint, query_cache_key, QueryCache, BATCH_PROTOCOL_VERSION,
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

/// Cap on the cumulative serialized `result` payloads across one batch.
///
/// The daemon wire refuses messages over [`MAX_MESSAGE_BYTES`] (64 KiB), so a
/// batch whose results individually pass each descriptor's
/// `maximum_output_bytes` can still overflow the frame once the envelope (ids,
/// flags, error shapes) is added. `40 KiB` of result payload leaves enough
/// headroom for a 64-op envelope (≈6 KiB) to always fit inside the wire cap.
/// Results that exceed the remaining batch budget are spilled to an artifact
/// file and replaced by a truncation marker (`truncated` + `artifactRef`).
///
/// [`MAX_MESSAGE_BYTES`]: crate::daemon::protocol::MAX_MESSAGE_BYTES
pub const MAX_BATCH_OUTPUT_BYTES: usize = 40 * 1024;

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
    /// True when `result` was replaced by a truncation marker because the
    /// serialized payload exceeded the descriptor's `maximum_output_bytes`
    /// (or the remaining batch output budget). The full payload is written to
    /// the file named by `artifact_ref`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub truncated: bool,
    /// Absolute path of the artifact file holding the full (untruncated)
    /// serialized payload, present when `truncated` is true.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact_ref: Option<String>,
}

/// `skip_serializing_if` predicate for [`OperationResponse::truncated`].
fn is_false(b: &bool) -> bool {
    !*b
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

// ─── Query cache context (Task 4, Phase 3) ─────────────────────────────────
//
// The batch executor serves Repository-cacheable ops (read/grep/search/
// outline/impact/testsFor) from the content-addressed query cache. The cache
// lives under the same worktree state dir the index uses
// (`<state-root>/fdx-index/<repo_id>/<worktree_id>/query-cache/`), so a
// repeat of the same query against the same repository state is served
// without re-execution. Only real git worktrees are cached: the key embeds
// the HEAD SHA and dirty fingerprint, which are meaningless (and unstable)
// outside git, and non-git temp dirs in tests stay uncached.

/// Precomputed per-batch cache inputs (identity + state hashes), built once
/// per batch and reused for every cacheable op. `None` means no caching.
struct QueryCacheContext {
    cache: QueryCache,
    repository_id: String,
    worktree_id: String,
    repository_sha: String,
    dirty_fingerprint: String,
    index_generation: u64,
    configuration_fingerprint: String,
}

impl QueryCacheContext {
    /// Resolve the cache context for a batch, or `None` when caching is not
    /// applicable (no cwd, not a git worktree, or no Repository-cacheable op).
    fn resolve(cwd: Option<&str>, operations: &[BatchOperation]) -> Option<Self> {
        let cwd = cwd?;
        // Only build when at least one op is Repository-cacheable.
        let any_cacheable = operations.iter().any(|op| {
            tool_descriptor(&op.op)
                .map(|d| d.cache_policy == CachePolicy::Repository)
                .unwrap_or(false)
        });
        if !any_cacheable {
            return None;
        }
        let worktree = Path::new(cwd);
        let repository_sha = git_head_sha(worktree);
        if repository_sha.is_empty() {
            // Not a git worktree: no meaningful state to key on.
            return None;
        }
        let identity = discover_identity(worktree, &fdx_version());
        let root = index_state_root();
        let state_dir = worktree_dir(&root, &identity.repository_id, &identity.worktree_id);
        Some(Self {
            cache: QueryCache::new(&state_dir),
            repository_id: identity.repository_id,
            worktree_id: identity.worktree_id,
            repository_sha,
            dirty_fingerprint: dirty_fingerprint(worktree),
            index_generation: 0, // set by the executor after freezing the snapshot
            configuration_fingerprint: configuration_fingerprint(
                &config_hash(worktree),
                &ignore_hash(worktree),
            ),
        })
    }

    /// The content-addressed cache key for one operation. Returns `None` when
    /// the op is not Repository-cacheable or the caller opted out via
    /// `no_cache`.
    fn key_for(&self, op: &BatchOperation) -> Option<String> {
        let d = tool_descriptor(&op.op)?;
        if d.cache_policy != CachePolicy::Repository {
            return None;
        }
        if op.params.no_cache == Some(true) {
            return None;
        }
        let canonical = canonical_json(&serde_json::to_value(&op.params).ok()?);
        Some(query_cache_key(
            &self.repository_id,
            &self.worktree_id,
            &self.repository_sha,
            &self.dirty_fingerprint,
            self.index_generation,
            BATCH_PROTOCOL_VERSION,
            &fdx_version(),
            &op.op,
            &canonical,
            &self.configuration_fingerprint,
        ))
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

    // Stale snapshot: the generation changed while the batch ran, so results
    // derived from `frozen` must not feed cache writes. Compute before the
    // loop so the loop can gate writes per op.
    let stale_snapshot = match (&frozen, index) {
        (Some(frozen), Some(idx)) => {
            idx.snapshot().map(|s| s.generation()) != Some(frozen.generation())
        }
        _ => false,
    };

    // Content-addressed query cache (Phase 3): one context per batch. The
    // generation component of the key comes from the frozen snapshot so
    // index-derived results never collide across generations.
    let mut cache_ctx = QueryCacheContext::resolve(cwd, operations);
    if let Some(ctx) = &mut cache_ctx {
        ctx.index_generation = frozen.as_ref().map(|s| s.generation()).unwrap_or(0);
    }

    let cache = AstCache::new();
    let mut responses = Vec::with_capacity(operations.len());
    let mut failed_fast = false;
    // Output-bounding (Phase 5): the cumulative serialized result payloads
    // across the batch may not exceed MAX_BATCH_OUTPUT_BYTES, so a batch of
    // individually-in-bounds results still fits the daemon wire frame. Each op
    // is truncated against min(descriptor.maximum_output_bytes, remaining).
    let mut used_output_bytes = 0usize;

    for op in operations {
        let budget = MAX_BATCH_OUTPUT_BYTES.saturating_sub(used_output_bytes);
        let (resp, used) = run_operation(
            op,
            cwd,
            frozen.as_deref(),
            &cache,
            cache_ctx.as_ref(),
            stale_snapshot,
            budget,
        );
        used_output_bytes += used;
        let stop = !resp.ok && fail_fast;
        responses.push(resp);
        if stop {
            failed_fast = true;
            break;
        }
    }

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
    cache_ctx: Option<&QueryCacheContext>,
    stale_snapshot: bool,
    output_budget: usize,
) -> (OperationResponse, usize) {
    let id = op.id.clone();
    // Every batch operation must be read-only, known, and batchable. The
    // registry marks `index.*` commands non-read-only and non-batchable:
    // both properties are enforced here (capability metadata contract).
    let descriptor = tool_descriptor(&op.op);
    match descriptor.as_ref() {
        None => {
            return (
                OperationResponse {
                    id,
                    ok: false,
                    result: None,
                    error: Some(serde_json::json!({
                        "code": err::E_UNSUPPORTED,
                        "message": format!("unknown batch operation '{}'", op.op),
                    })),
                    truncated: false,
                    artifact_ref: None,
                },
                0,
            );
        }
        Some(d) if !d.read_only => {
            return (
                OperationResponse {
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
                    truncated: false,
                    artifact_ref: None,
                },
                0,
            );
        }
        Some(d) if !d.supports_batching => {
            return (
                OperationResponse {
                    id,
                    ok: false,
                    result: None,
                    error: Some(serde_json::json!({
                        "code": err::E_UNSUPPORTED,
                        "message": format!(
                            "operation '{}' does not support batching",
                            op.op
                        ),
                    })),
                    truncated: false,
                    artifact_ref: None,
                },
                0,
            );
        }
        _ => {}
    }
    // Output bound (Phase 5): the effective limit is the descriptor's
    // maximum_output_bytes, further capped by the remaining batch budget so
    // the cumulative payload stays inside the daemon wire frame.
    let descriptor_limit = descriptor
        .as_ref()
        .map(|d| d.maximum_output_bytes)
        .unwrap_or(0);
    let effective_limit = descriptor_limit.min(output_budget);

    // Query cache: serve Repository-cacheable ops from disk when the key
    // matches the current repository state. The key is `None` for ops that
    // are not cacheable or opted out via `no_cache`. Negative-cache-eligible
    // ops check the negative namespace first (definitive-empty results only).
    let cache_key = cache_ctx.and_then(|ctx| ctx.key_for(op));
    if let (Some(ctx), Some(key)) = (&cache_ctx, &cache_key) {
        let negative_eligible = descriptor
            .as_ref()
            .is_some_and(|d| d.negative_cache_eligible);
        let cached: Option<Value> = if negative_eligible {
            ctx.cache
                .get_negative(key)
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        } else {
            None
        };
        let cached = cached.or_else(|| {
            ctx.cache
                .get(key)
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        });
        if let Some(value) = cached {
            // Cached values were stored in full; re-enforce the current
            // bounds before returning (descriptor limits can change).
            return finalize_response(
                id,
                value,
                effective_limit,
                cache_ctx.map(|c| c.cache.state_dir()),
            );
        }
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
        Ok(value) => {
            // Cache the fresh result only when the snapshot is not stale and
            // the op is Repository-cacheable. Definitive-empty outcomes of
            // negative-cache-eligible ops go to the negative namespace (TTL-
            // bounded); everything else to the positive namespace. The cache
            // always stores the FULL payload; truncation is a response-time
            // concern.
            if let (Some(ctx), Some(key)) = (&cache_ctx, &cache_key) {
                if !stale_snapshot {
                    if let Ok(bytes) = serde_json::to_vec(&value) {
                        if is_definitive_empty(&op.op, &value) {
                            ctx.cache.put_negative(key, &bytes);
                        } else {
                            ctx.cache.put(key, &bytes);
                        }
                    }
                }
            }
            finalize_response(
                id,
                value,
                effective_limit,
                cache_ctx.map(|c| c.cache.state_dir()),
            )
        }
        Err((code, message)) => (
            OperationResponse {
                id,
                ok: false,
                result: None,
                error: Some(serde_json::json!({ "code": code, "message": message })),
                truncated: false,
                artifact_ref: None,
            },
            0,
        ),
    }
}

/// Build the success response for an op's value, enforcing the output bound.
///
/// When the serialized payload exceeds `limit`, the full payload is written to
/// an artifact file (next to the query cache namespaces, or a temp dir when no
/// worktree cache context exists) and `result` is replaced by a small marker
/// describing the truncation. The reported `used` bytes always reflect the
/// full payload, so the batch budget stays conservative even across repeated
/// truncations.
fn finalize_response(
    id: String,
    value: Value,
    limit: usize,
    artifact_base: Option<&Path>,
) -> (OperationResponse, usize) {
    let Ok(bytes) = serde_json::to_vec(&value) else {
        return (
            OperationResponse {
                id,
                ok: false,
                result: None,
                error: Some(serde_json::json!({
                    "code": err::E_INTERNAL,
                    "message": "failed to serialize operation result",
                })),
                truncated: false,
                artifact_ref: None,
            },
            0,
        );
    };
    let used = bytes.len();
    if used <= limit {
        return (
            OperationResponse {
                id,
                ok: true,
                result: Some(value),
                error: None,
                truncated: false,
                artifact_ref: None,
            },
            used,
        );
    }

    // Over budget: spill the full payload to an artifact and return a marker.
    let dir = artifact_base
        .map(|p| p.join("artifacts"))
        .unwrap_or_else(|| std::env::temp_dir().join("fdx-batch-artifacts"));
    let file_name = sanitize_artifact_name(&id);
    let path = dir.join(format!("{file_name}.json"));
    let wrote = std::fs::create_dir_all(&dir)
        .and_then(|()| std::fs::write(&path, &bytes))
        .map(|()| path.to_string_lossy().into_owned());
    let artifact_ref = match wrote {
        Ok(p) => p,
        Err(e) => {
            return (
                OperationResponse {
                    id,
                    ok: false,
                    result: None,
                    error: Some(serde_json::json!({
                        "code": err::E_INTERNAL,
                        "message": format!("failed to write artifact: {e}"),
                    })),
                    truncated: false,
                    artifact_ref: None,
                },
                used,
            );
        }
    };
    (
        OperationResponse {
            id,
            ok: true,
            result: Some(serde_json::json!({
                "truncated": true,
                "artifactRef": artifact_ref,
                "byteCount": used,
                "limitBytes": limit,
            })),
            error: None,
            truncated: true,
            artifact_ref: Some(artifact_ref),
        },
        used,
    )
}

/// Make an op id safe to use as a file name (ids are client-chosen and may
/// contain path separators or other characters that would escape the artifact
/// directory).
fn sanitize_artifact_name(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push_str("op");
    }
    out
}

/// Whether a result is a definitive-empty outcome — the only kind that may be
/// negatively cached. A `grep`/`search` with zero matches, or a `testsFor`
/// with no rows, is a definitive answer (nothing was found NOW); error or
/// partial results are never negative-cached.
fn is_definitive_empty(op: &str, value: &Value) -> bool {
    match op {
        "grep" | "search" => {
            value
                .get("total_matches")
                .and_then(|v| v.as_u64())
                .unwrap_or(1)
                == 0
        }
        "testsFor" => value
            .as_array()
            .map(|rows| rows.is_empty())
            .unwrap_or(false),
        _ => false,
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

    // ─── Query cache wiring ──────────────────────────────────────────────────

    /// Serializes the FDX_INDEX_DIR env var so cache tests don't race each
    /// other (or the paths module test) over process-global env state.
    static CACHE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Initializes a real git repository (HEAD present, clean tree) so the
    /// cache context activates.
    fn git_init(path: &std::path::Path) {
        for args in [
            &["init", "-q"][..],
            &["config", "user.email", "cache-test@example.com"][..],
            &["config", "user.name", "cache-test"][..],
            &["add", "-A"][..],
            &["commit", "-q", "-m", "init"][..],
        ] {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(path)
                .output()
                .expect("git must be installed for cache tests");
            assert!(
                out.status.success(),
                "git {args:?} failed: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
    }

    /// Number of cache files in a given namespace (`query-cache` or
    /// `negative-cache`) under the given FDX_INDEX_DIR root.
    fn cache_entry_count_in(state_root: &std::path::Path, namespace: &str) -> usize {
        let qc = state_root.join(crate::index::paths::INDEX_NAMESPACE);
        if !qc.exists() {
            return 0;
        }
        let mut count = 0;
        // <root>/fdx-index/<repo>/<worktree>/<namespace>/*
        if let Ok(repos) = std::fs::read_dir(&qc) {
            for repo in repos.flatten() {
                if let Ok(worktrees) = std::fs::read_dir(repo.path()) {
                    for wt in worktrees.flatten() {
                        let dir = wt.path().join(namespace);
                        count += std::fs::read_dir(&dir)
                            .map(|e| e.flatten().count())
                            .unwrap_or(0);
                    }
                }
            }
        }
        count
    }

    /// Number of positive query-cache entries.
    fn cache_entry_count(state_root: &std::path::Path) -> usize {
        cache_entry_count_in(state_root, crate::index::query_cache::QUERY_CACHE_DIR)
    }

    #[test]
    fn query_cache_roundtrips_and_flips_key_on_change() {
        let _guard = CACHE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os(crate::index::paths::INDEX_DIR_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::env::set_var(crate::index::paths::INDEX_DIR_ENV, state.path());

        std::fs::write(
            tmp.path().join("lib.ts"),
            "export const greeting = \"hi\"\n",
        )
        .unwrap();
        git_init(tmp.path());

        let cwd = tmp.path().to_str().unwrap();
        let read_op = || {
            vec![op(
                "r1",
                "read",
                serde_json::json!({ "file": "lib.ts", "mode": "raw" }),
            )]
        };

        // 1. First execution: cache miss, result computed, entry written.
        let resp1 = execute_batch(&read_op(), Some(cwd), None, false).unwrap();
        let r1 = ok_result(&resp1.responses[0]);
        assert_eq!(r1["total_lines"], 1);
        assert_eq!(
            cache_entry_count(state.path()),
            1,
            "first run writes one cache entry"
        );

        // 2. Identical second execution: served from cache (still 1 entry).
        let resp2 = execute_batch(&read_op(), Some(cwd), None, false).unwrap();
        assert_eq!(
            ok_result(&resp2.responses[0]),
            r1,
            "cached result is identical"
        );
        assert_eq!(
            cache_entry_count(state.path()),
            1,
            "repeat is a cache hit, no new entry"
        );

        // 3. Content change flips the dirty fingerprint → new key → fresh result.
        std::fs::write(
            tmp.path().join("lib.ts"),
            "export const greeting = \"hello\"\n",
        )
        .unwrap();
        let resp3 = execute_batch(&read_op(), Some(cwd), None, false).unwrap();
        let r3 = ok_result(&resp3.responses[0]);
        assert_eq!(r3["lines"][0], "export const greeting = \"hello\"");
        assert_eq!(
            cache_entry_count(state.path()),
            2,
            "content change writes a new entry"
        );

        match prev {
            Some(v) => std::env::set_var(crate::index::paths::INDEX_DIR_ENV, v),
            None => std::env::remove_var(crate::index::paths::INDEX_DIR_ENV),
        }
    }

    #[test]
    fn query_cache_is_inactive_outside_git_repos() {
        let _guard = CACHE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os(crate::index::paths::INDEX_DIR_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::env::set_var(crate::index::paths::INDEX_DIR_ENV, state.path());

        std::fs::write(tmp.path().join("a.txt"), "line1\n").unwrap();
        let ops = vec![op(
            "r1",
            "read",
            serde_json::json!({ "file": "a.txt", "mode": "raw" }),
        )];
        let resp = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap();
        assert_eq!(ok_result(&resp.responses[0])["total_lines"], 1);
        assert_eq!(
            cache_entry_count(state.path()),
            0,
            "non-git cwd must not touch the query cache"
        );

        match prev {
            Some(v) => std::env::set_var(crate::index::paths::INDEX_DIR_ENV, v),
            None => std::env::remove_var(crate::index::paths::INDEX_DIR_ENV),
        }
    }

    #[test]
    fn definitive_empty_results_use_the_negative_cache() {
        let _guard = CACHE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os(crate::index::paths::INDEX_DIR_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::env::set_var(crate::index::paths::INDEX_DIR_ENV, state.path());

        std::fs::write(
            tmp.path().join("lib.ts"),
            "export const greeting = \"hi\"\n",
        )
        .unwrap();
        git_init(tmp.path());
        let cwd = tmp.path().to_str().unwrap();

        // grep with zero matches → definitive-empty → negative namespace only.
        let grep_none = || {
            vec![op(
                "g1",
                "grep",
                serde_json::json!({ "pattern": "no-such-symbol", "paths": ["."] }),
            )]
        };
        let resp = execute_batch(&grep_none(), Some(cwd), None, false).unwrap();
        assert_eq!(ok_result(&resp.responses[0])["total_matches"], 0);
        assert_eq!(
            cache_entry_count_in(state.path(), crate::index::query_cache::NEGATIVE_CACHE_DIR),
            1,
            "definitive-empty grep is stored in the negative namespace"
        );
        assert_eq!(
            cache_entry_count(state.path()),
            0,
            "definitive-empty grep never lands in the positive namespace"
        );

        // Repeat: served from the negative cache (still one entry).
        let resp2 = execute_batch(&grep_none(), Some(cwd), None, false).unwrap();
        assert_eq!(ok_result(&resp2.responses[0])["total_matches"], 0);
        assert_eq!(
            cache_entry_count_in(state.path(), crate::index::query_cache::NEGATIVE_CACHE_DIR),
            1,
            "repeat negative hit adds no entry"
        );

        // grep WITH matches → positive namespace (not negative).
        let grep_hit = || {
            vec![op(
                "g2",
                "grep",
                serde_json::json!({ "pattern": "greeting", "paths": ["."] }),
            )]
        };
        let resp3 = execute_batch(&grep_hit(), Some(cwd), None, false).unwrap();
        assert_eq!(ok_result(&resp3.responses[0])["total_matches"], 1);
        assert_eq!(
            cache_entry_count(state.path()),
            1,
            "non-empty grep is stored in the positive namespace"
        );
        assert_eq!(
            cache_entry_count_in(state.path(), crate::index::query_cache::NEGATIVE_CACHE_DIR),
            1,
            "non-empty grep must not touch the negative namespace"
        );

        match prev {
            Some(v) => std::env::set_var(crate::index::paths::INDEX_DIR_ENV, v),
            None => std::env::remove_var(crate::index::paths::INDEX_DIR_ENV),
        }
    }

    #[test]
    fn non_batchable_op_is_rejected_per_op() {
        let tmp = tempfile::tempdir().unwrap();
        let ops = vec![op("c1", "capabilities.query", serde_json::json!({}))];
        let resp = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap();
        let r = &resp.responses[0];
        assert!(!r.ok);
        assert_eq!(r.error.as_ref().unwrap()["code"], err::E_UNSUPPORTED);
        assert!(r.error.as_ref().unwrap()["message"]
            .as_str()
            .unwrap()
            .contains("does not support batching"));
    }

    #[test]
    fn truncated_result_gets_artifact_marker() {
        // A read far beyond the descriptor bound (256 KiB for `read`) must be
        // truncated: the full payload lands in an artifact file, the response
        // carries `truncated: true` + `artifactRef`, and the marker records
        // byte counts. Non-git cwd → no cache context → artifacts fall back
        // to the temp dir, which keeps this test hermetic.
        let tmp = tempfile::tempdir().unwrap();
        let big = "x".repeat(300 * 1024);
        std::fs::write(tmp.path().join("big.txt"), &big).unwrap();

        let ops = vec![op(
            "r1",
            "read",
            serde_json::json!({ "file": "big.txt", "mode": "raw" }),
        )];
        let resp = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap();
        let r = &resp.responses[0];
        assert!(r.ok, "truncation is not a failure: {r:?}");
        assert!(r.truncated, "oversized result must be flagged truncated");
        let artifact_ref = r.artifact_ref.as_ref().expect("artifactRef on truncation");
        let marker = r.result.as_ref().unwrap();
        assert_eq!(marker["truncated"], true);
        assert_eq!(marker["artifactRef"], artifact_ref.as_str());
        assert!(marker["byteCount"].as_u64().unwrap() >= big.len() as u64);
        assert!(marker["limitBytes"].as_u64().unwrap() <= 256 * 1024);

        // The artifact holds the FULL payload (round-trips exactly); the
        // byte count matches the artifact's size.
        let full = std::fs::read(artifact_ref).unwrap();
        assert_eq!(full.len(), marker["byteCount"].as_u64().unwrap() as usize);
        let parsed: serde_json::Value = serde_json::from_slice(&full).unwrap();
        assert_eq!(parsed["lines"][0].as_str().unwrap(), big.as_str());
    }

    #[test]
    fn batch_total_budget_truncates_when_cumulative_output_overflows() {
        // Each op alone is under its descriptor bound, but the CUMULATIVE
        // serialized payload across the batch exceeds MAX_BATCH_OUTPUT_BYTES:
        // the batch-total bound must truncate later ops, keeping the whole
        // response inside the wire frame (Phase 5).
        let tmp = tempfile::tempdir().unwrap();
        let big = "y".repeat(22 * 1024);
        std::fs::write(tmp.path().join("a.txt"), &big).unwrap();
        std::fs::write(tmp.path().join("b.txt"), &big).unwrap();

        let ops = vec![
            op(
                "r1",
                "read",
                serde_json::json!({ "file": "a.txt", "mode": "raw" }),
            ),
            op(
                "r2",
                "read",
                serde_json::json!({ "file": "b.txt", "mode": "raw" }),
            ),
        ];
        let resp = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap();
        let first = &resp.responses[0];
        let second = &resp.responses[1];
        // 22 KiB each is below the 256 KiB descriptor bound; at least one op
        // must still be truncated by the batch-total budget.
        assert!(
            first.truncated || second.truncated,
            "batch-total bound must bite: {resp:?}"
        );
        assert!(
            second.truncated,
            "later ops truncate when the budget is exhausted"
        );
        assert!(first.artifact_ref.is_some() || second.artifact_ref.is_some());
    }

    #[test]
    fn under_budget_results_are_not_truncated() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("small.txt"), "hello world\n").unwrap();
        let ops = vec![op(
            "r1",
            "read",
            serde_json::json!({ "file": "small.txt", "mode": "raw" }),
        )];
        let resp = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap();
        let r = &resp.responses[0];
        assert!(r.ok);
        assert!(!r.truncated);
        assert!(r.artifact_ref.is_none());
        assert_eq!(ok_result(r)["total_lines"], 1);
    }

    #[test]
    fn artifact_name_is_sanitized() {
        // Op ids are client-chosen; path separators must not escape the
        // artifact directory.
        let name = sanitize_artifact_name("../evil/op id");
        assert_eq!(name, "___evil_op_id");
        assert_eq!(sanitize_artifact_name(""), "op");
        assert_eq!(sanitize_artifact_name("grep-1"), "grep-1");
    }
}
