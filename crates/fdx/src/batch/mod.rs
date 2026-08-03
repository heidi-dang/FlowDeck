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
//!   failed operation, every unstarted operation returns an explicit
//!   `E_CANCELLED` response (never executes), and `failed_fast=true`. The
//!   response always contains exactly one entry per input operation.
//! - Whole-batch preflight: every operation must be a known, read-only,
//!   batchable op. Any invalid operation (unknown tag, non-read-only, or
//!   non-batchable) rejects the ENTIRE batch with `E_BAD_REQUEST` before ANY
//!   operation executes — zero execution, no partial results.
//! - Max 64 operations per batch; duplicate ids and empty batches are
//!   rejected structurally.
//! - Repository-state contract: the batch captures HEAD SHA, dirty
//!   fingerprint, and configuration fingerprint at batch start and
//!   revalidates them before every cache read/write and before each
//!   operation. On drift, all remaining operations are ABORTED with
//!   `E_STALE_SNAPSHOT` (never executed), the batch reports
//!   `stale_snapshot: true`, and no results from the batch are persisted.
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
use std::io::Write;
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
    /// An operation that never started because an earlier op failed with
    /// `fail_fast` set. The operation was NOT executed; the response exists
    /// only to preserve the one-response-per-input-operation cardinality.
    pub const E_CANCELLED: &str = "E_CANCELLED";
    /// An operation that never started because the repository state drifted
    /// mid-batch (HEAD / dirty tree / config changed since capture). The
    /// operation was NOT executed; the batch is flagged `stale_snapshot` so
    /// clients never persist results spanning two repository states. This is
    /// a distinct condition from fail-fast cancellation: the batch was not
    /// stopped by the client, it was invalidated by an external mutation.
    pub const E_STALE_SNAPSHOT: &str = "E_STALE_SNAPSHOT";
}

// ─── Parameter preflight validators ──────────────────────────────────────────

/// Validation error for a single operation parameter.
type ParamError = (Option<&'static str>, &'static str, String);

/// Validate operation parameters before any execution. Returns `Ok(())` when
/// the parameters are structurally and semantically valid, or `Err` with the
/// operation tag, a stable error code, and a human-readable message when they
/// are not. This runs in whole-batch preflight: any failure rejects the ENTIRE
/// batch with `E_BAD_REQUEST` before any operation executes.
fn validate_operation_params(op: &BatchOperation) -> Result<(), ParamError> {
    match op.op.as_str() {
        "read" => validate_read_params(&op.params),
        "grep" => validate_grep_params(&op.params),
        "search" => validate_search_params(&op.params),
        "outline" => validate_outline_params(&op.params),
        "impact" => validate_impact_params(&op.params),
        "testsFor" => validate_tests_for_params(&op.params),
        _ => {
            // Unknown ops are already rejected by descriptor preflight; this
            // path is unreachable in practice but keeps the validator total.
            Err((
                None,
                err::E_BAD_REQUEST,
                format!("unknown batch operation '{}'", op.op),
            ))
        }
    }
}

/// `read` parameter validation.
///
/// Rejects:
/// - missing `file`
/// - empty `file`
/// - unsupported `mode`
/// - `limit` or `offset` out of bounds
/// - `symbol` with `mode=raw` (symbol only applies to code modes)
/// - contradictory combinations
fn validate_read_params(params: &OperationParams) -> Result<(), ParamError> {
    let file = params.file.as_deref().ok_or_else(|| {
        (
            Some("read"),
            err::E_BAD_REQUEST,
            "read requires 'file'".into(),
        )
    })?;
    if file.trim().is_empty() {
        return Err((
            Some("read"),
            err::E_BAD_REQUEST,
            "read 'file' must not be empty".into(),
        ));
    }
    if file.contains('\0') {
        return Err((
            Some("read"),
            err::E_BAD_REQUEST,
            "read 'file' contains embedded NUL".into(),
        ));
    }
    let mode = params.mode.as_deref().unwrap_or("auto");
    if !matches!(mode, "auto" | "raw" | "prototype" | "deep") {
        return Err((
            Some("read"),
            err::E_BAD_REQUEST,
            format!("invalid read mode: {mode}"),
        ));
    }
    if let Some(limit) = params.limit {
        if limit == 0 || limit > 10_000 {
            return Err((
                Some("read"),
                err::E_BAD_REQUEST,
                format!("read 'limit' must be in 1..=10000, got {limit}"),
            ));
        }
    }
    if let Some(offset) = params.offset {
        if offset == 0 || offset > 1_000_000 {
            return Err((
                Some("read"),
                err::E_BAD_REQUEST,
                format!("read 'offset' must be in 1..=1000000, got {offset}"),
            ));
        }
    }
    if mode == "raw" && params.symbol.is_some() {
        return Err((
            Some("read"),
            err::E_BAD_REQUEST,
            "read 'symbol' is not valid with mode 'raw'".into(),
        ));
    }
    Ok(())
}

/// `grep` parameter validation.
///
/// Rejects:
/// - missing or empty `pattern`
/// - invalid regex when `fixedStrings` is false
/// - `context_lines` out of bounds
/// - structurally invalid `paths`
/// - contradictory options
fn validate_grep_params(params: &OperationParams) -> Result<(), ParamError> {
    let pattern = params.pattern.as_deref().ok_or_else(|| {
        (
            Some("grep"),
            err::E_BAD_REQUEST,
            "grep requires 'pattern'".into(),
        )
    })?;
    if pattern.trim().is_empty() {
        return Err((
            Some("grep"),
            err::E_BAD_REQUEST,
            "grep 'pattern' must not be empty".into(),
        ));
    }
    if !params.fixed_strings.unwrap_or(false) {
        if let Err(e) = regex::Regex::new(pattern) {
            return Err((
                Some("grep"),
                err::E_BAD_REQUEST,
                format!("grep 'pattern' is not a valid regex: {e}"),
            ));
        }
    }
    if let Some(ctx) = params.context_lines {
        if ctx > 3 {
            return Err((
                Some("grep"),
                err::E_BAD_REQUEST,
                format!("grep 'context_lines' must be <= 3, got {ctx}"),
            ));
        }
    }
    if let Some(max) = params.max_matches {
        if max == 0 || max > 200 {
            return Err((
                Some("grep"),
                err::E_BAD_REQUEST,
                format!("grep 'max_matches' must be in 1..=200, got {max}"),
            ));
        }
    }
    for path in &params.paths {
        if path.contains('\0') {
            return Err((
                Some("grep"),
                err::E_BAD_REQUEST,
                "grep 'paths' contains embedded NUL".into(),
            ));
        }
    }
    Ok(())
}

/// `search` parameter validation.
///
/// Rejects:
/// - missing or empty `pattern`
/// - unsupported `kind_filter`
/// - `max_matches` out of bounds
/// - structurally invalid boolean/enum fields
fn validate_search_params(params: &OperationParams) -> Result<(), ParamError> {
    let pattern = params.pattern.as_deref().ok_or_else(|| {
        (
            Some("search"),
            err::E_BAD_REQUEST,
            "search requires 'pattern'".into(),
        )
    })?;
    if pattern.trim().is_empty() {
        return Err((
            Some("search"),
            err::E_BAD_REQUEST,
            "search 'pattern' must not be empty".into(),
        ));
    }
    if let Some(kind) = params.kind_filter.as_deref() {
        if !matches!(
            kind,
            "any" | "function" | "class" | "struct" | "trait" | "enum" | "const" | "type"
        ) {
            return Err((
                Some("search"),
                err::E_BAD_REQUEST,
                format!("search 'kind_filter' is not supported: {kind}"),
            ));
        }
    }
    if let Some(max) = params.max_matches {
        if max == 0 || max > 500 {
            return Err((
                Some("search"),
                err::E_BAD_REQUEST,
                format!("search 'max_matches' must be in 1..=500, got {max}"),
            ));
        }
    }
    Ok(())
}

/// `outline` parameter validation.
///
/// Rejects:
/// - structurally invalid `paths`
/// - `depth` out of bounds
/// - `min_lines` out of bounds
fn validate_outline_params(params: &OperationParams) -> Result<(), ParamError> {
    if let Some(depth) = params.depth {
        if depth == 0 || depth > 10 {
            return Err((
                Some("outline"),
                err::E_BAD_REQUEST,
                format!("outline 'depth' must be in 1..=10, got {depth}"),
            ));
        }
    }
    if let Some(min) = params.min_lines {
        if min == 0 || min > 1000 {
            return Err((
                Some("outline"),
                err::E_BAD_REQUEST,
                format!("outline 'min_lines' must be in 1..=1000, got {min}"),
            ));
        }
    }
    for path in &params.paths {
        if path.contains('\0') {
            return Err((
                Some("outline"),
                err::E_BAD_REQUEST,
                "outline 'paths' contains embedded NUL".into(),
            ));
        }
    }
    Ok(())
}

/// `impact` parameter validation.
///
/// Rejects:
/// - missing or empty `targets`
/// - unsupported `direction`
/// - `depth` out of bounds
/// - structurally invalid `root`
fn validate_impact_params(params: &OperationParams) -> Result<(), ParamError> {
    if params.targets.is_empty() {
        return Err((
            Some("impact"),
            err::E_BAD_REQUEST,
            "impact requires at least one 'targets' entry".into(),
        ));
    }
    let direction = params.direction.as_deref().unwrap_or("both");
    if !matches!(direction, "in" | "out" | "both") {
        return Err((
            Some("impact"),
            err::E_BAD_REQUEST,
            format!("invalid impact direction: {direction}"),
        ));
    }
    if let Some(depth) = params.depth {
        if depth == 0 || depth > 1 {
            return Err((
                Some("impact"),
                err::E_BAD_REQUEST,
                format!("impact 'depth' must be 1, got {depth}"),
            ));
        }
    }
    if let Some(root) = params.root.as_deref() {
        if root.contains('\0') {
            return Err((
                Some("impact"),
                err::E_BAD_REQUEST,
                "impact 'root' contains embedded NUL".into(),
            ));
        }
    }
    for target in &params.targets {
        if target.contains('\0') {
            return Err((
                Some("impact"),
                err::E_BAD_REQUEST,
                "impact 'targets' contains embedded NUL".into(),
            ));
        }
    }
    Ok(())
}

/// `testsFor` parameter validation.
///
/// Rejects:
/// - missing or empty `source`
/// - structurally invalid `source`
fn validate_tests_for_params(params: &OperationParams) -> Result<(), ParamError> {
    let source = params.source.as_deref().ok_or_else(|| {
        (
            Some("testsFor"),
            err::E_BAD_REQUEST,
            "testsFor requires 'source'".into(),
        )
    })?;
    if source.trim().is_empty() {
        return Err((
            Some("testsFor"),
            err::E_BAD_REQUEST,
            "testsFor 'source' must not be empty".into(),
        ));
    }
    if source.contains('\0') {
        return Err((
            Some("testsFor"),
            err::E_BAD_REQUEST,
            "testsFor 'source' contains embedded NUL".into(),
        ));
    }
    Ok(())
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
    /// Repository-state guard captured at batch start; revalidated before
    /// every cache write and before the final response is emitted.
    probe: RepoStateProbe,
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
        let dirty = dirty_fingerprint(worktree);
        let config = configuration_fingerprint(&config_hash(worktree), &ignore_hash(worktree));
        Some(Self {
            cache: QueryCache::new(&state_dir),
            repository_id: identity.repository_id,
            worktree_id: identity.worktree_id,
            repository_sha: repository_sha.clone(),
            dirty_fingerprint: dirty.clone(),
            index_generation: 0, // set by the executor after freezing the snapshot
            configuration_fingerprint: config.clone(),
            probe: RepoStateProbe::capture(worktree, &repository_sha, &dirty, &config),
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

    /// The repository-state probe captured with this cache context.
    fn probe(&self) -> &RepoStateProbe {
        &self.probe
    }
}

/// Repository-state revalidation contract (Phase 7 audit).
///
/// The batch captures the repository identity fields (HEAD SHA, dirty
/// working-tree fingerprint, configuration fingerprint) at batch start and
/// revalidates them before every cache write and before the final response
/// is emitted. If ANY captured field changed, the batch is marked stale:
/// cache writes are aborted, cached results are no longer reused, and
/// `stale_snapshot: true` is reported so clients never persist results that
/// span two repository states.
pub trait BatchStateProbe: Sync {
    /// True while the captured repository state still matches the worktree.
    fn state_unchanged(&self) -> bool;
}

/// Production state probe: recomputes HEAD SHA, dirty fingerprint and
/// configuration fingerprint and compares each against the captured value.
pub struct RepoStateProbe {
    worktree: PathBuf,
    repository_sha: String,
    dirty_fingerprint: String,
    configuration_fingerprint: String,
}

impl RepoStateProbe {
    /// Capture the repository state fields for later revalidation.
    pub fn capture(
        worktree: &Path,
        repository_sha: &str,
        dirty_fingerprint: &str,
        configuration_fingerprint: &str,
    ) -> Self {
        Self {
            worktree: worktree.to_path_buf(),
            repository_sha: repository_sha.to_string(),
            dirty_fingerprint: dirty_fingerprint.to_string(),
            configuration_fingerprint: configuration_fingerprint.to_string(),
        }
    }
}

impl BatchStateProbe for RepoStateProbe {
    fn state_unchanged(&self) -> bool {
        if git_head_sha(&self.worktree) != self.repository_sha {
            return false;
        }
        if dirty_fingerprint(&self.worktree) != self.dirty_fingerprint {
            return false;
        }
        configuration_fingerprint(&config_hash(&self.worktree), &ignore_hash(&self.worktree))
            == self.configuration_fingerprint
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
    execute_batch_with_probe(operations, cwd, index, fail_fast, None)
}

/// [`execute_batch`] with an injectable repository-state probe (test seam).
/// `probe` overrides the production [`RepoStateProbe`] when provided.
fn execute_batch_with_probe(
    operations: &[BatchOperation],
    cwd: Option<&str>,
    index: Option<&dyn BatchIndexProvider>,
    fail_fast: bool,
    probe: Option<&dyn BatchStateProbe>,
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

    // Whole-batch preflight: every operation must be a known, read-only,
    // batchable op. An invalid operation (unknown tag, non-read-only, or
    // non-batchable) rejects the ENTIRE batch with E_BAD_REQUEST before ANY
    // operation executes — zero execution, no partial results, no cache
    // reads or writes. The daemon, one-shot CLI, and TS fallback share this
    // contract. (Previously invalid ops were per-op E_UNSUPPORTED, which let
    // valid ops run alongside an invalid one; the contract forbids that.)
    for op in operations {
        let descriptor = tool_descriptor(&op.op);
        let invalid = match descriptor {
            None => Some(format!("unknown batch operation '{}'", op.op)),
            Some(d) if !d.read_only => Some(format!(
                "operation '{}' is not read-only and cannot run in a batch",
                op.op
            )),
            Some(d) if !d.supports_batching => {
                Some(format!("operation '{}' does not support batching", op.op))
            }
            _ => None,
        };
        if let Some(message) = invalid {
            return Err(BatchReject {
                code: err::E_BAD_REQUEST,
                message,
            });
        }
    }

    // Parameter preflight: validate every operation's request parameters
    // before any operation executes. An invalid parameter set rejects the
    // ENTIRE batch with E_BAD_REQUEST — zero execution, no cache reads or
    // writes, no artifact files. This catches malformed requests that the
    // operation would deterministically reject before filesystem access.
    for op in operations {
        if let Err((tag, code, message)) = validate_operation_params(op) {
            let op_tag = tag.unwrap_or(&op.op);
            return Err(BatchReject {
                code,
                message: format!("operation '{op_tag}': {message}"),
            });
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
    let mut stale_snapshot = match (&frozen, index) {
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
    // The effective state probe: an injected test probe wins over the
    // production probe embedded in the cache context.
    let eff_probe: Option<&dyn BatchStateProbe> = probe.or_else(|| {
        cache_ctx
            .as_ref()
            .map(|c| c.probe() as &dyn BatchStateProbe)
    });

    let cache = AstCache::new();
    let mut responses = Vec::with_capacity(operations.len());
    let mut failed_fast = false;
    // Repository-state drift detected mid-batch (HEAD / dirty tree / config
    // changed since capture). Once set, the batch never reads from or writes
    // to the cache again and the response is flagged `stale_snapshot`.
    let mut state_changed = false;
    // Output-bounding (Phase 5): the cumulative serialized result payloads
    // across the batch may not exceed MAX_BATCH_OUTPUT_BYTES, so a batch of
    // individually-in-bounds results still fits the daemon wire frame. Each op
    // is truncated against min(descriptor.maximum_output_bytes, remaining).
    let mut used_output_bytes = 0usize;

    for op in operations {
        if failed_fast {
            // Cardinality contract: every input operation gets exactly one
            // response. Operations that never started (fail-fast) return an
            // explicit cancellation response and are never executed — no
            // cache reads, no cache writes, no side effects.
            responses.push(cancelled_response(op.id.clone()));
            continue;
        }
        // Repository-state drift: once the captured state no longer matches
        // the worktree, every remaining operation is ABORTED — never
        // executed, never cached. The dedicated E_STALE_SNAPSHOT code keeps
        // this distinct from fail-fast cancellation (the batch was not
        // stopped by the client; it was invalidated by an external mutation),
        // and `stale_snapshot` tells clients not to persist any results from
        // this batch.
        if state_changed {
            responses.push(stale_abort_response(op.id.clone()));
            continue;
        }
        // Revalidate the captured repository state before each operation so
        // drift is detected even for ops that never touch the cache.
        if let Some(p) = eff_probe {
            if !p.state_unchanged() {
                state_changed = true;
                responses.push(stale_abort_response(op.id.clone()));
                continue;
            }
        }
        let budget = MAX_BATCH_OUTPUT_BYTES.saturating_sub(used_output_bytes);
        let (resp, used) = run_operation(
            op,
            cwd,
            frozen.as_deref(),
            &cache,
            cache_ctx.as_ref(),
            eff_probe,
            stale_snapshot,
            &mut state_changed,
            budget,
        );
        used_output_bytes += used;
        let stop = !resp.ok && fail_fast;
        responses.push(resp);
        if stop {
            failed_fast = true;
        }
    }

    // Repository-state revalidation before the final response is emitted: a
    // change detected after the last op (or during any op) still marks the
    // whole batch stale, so clients never persist cross-state results. This
    // outer check is NOT merely a flag: when the drift is first detected HERE
    // (no mid-loop drift was seen, so every accepted success is still a
    // provisional result that has not passed a batch-level final commit
    // barrier), every accepted success is invalidated to E_STALE_SNAPSHOT.
    // Ops that were already discarded mid-batch (stale aborts, fail-fast
    // cancellations) are untouched.
    let mut envelope_drift = false;
    if !state_changed {
        if let Some(p) = eff_probe {
            if !p.state_unchanged() {
                state_changed = true;
                envelope_drift = true;
            }
        }
    }
    if envelope_drift {
        for resp in &mut responses {
            if resp.ok {
                resp.ok = false;
                resp.result = None;
                resp.error = Some(serde_json::json!({
                    "code": err::E_STALE_SNAPSHOT,
                    "message": "operation result discarded: repository state changed during execution",
                }));
                resp.truncated = false;
                resp.artifact_ref = None;
            }
        }
    }
    // Index-generation revalidation (frozen snapshot vs the live service).
    if !stale_snapshot {
        if let (Some(frozen), Some(idx)) = (&frozen, index) {
            if idx.snapshot().map(|s| s.generation()) != Some(frozen.generation()) {
                stale_snapshot = true;
            }
        }
    }

    Ok(BatchResponse {
        version: 1,
        responses,
        failed_fast,
        stale_snapshot: stale_snapshot || state_changed,
    })
}

/// Cancellation response for an operation that never started because an
/// earlier operation failed with `fail_fast`. The response exists to preserve
/// the one-response-per-input-operation cardinality; the operation itself was
/// NOT executed.
fn cancelled_response(id: String) -> OperationResponse {
    OperationResponse {
        id,
        ok: false,
        result: None,
        error: Some(serde_json::json!({
            "code": err::E_CANCELLED,
            "message": "operation cancelled by fail-fast",
        })),
        truncated: false,
        artifact_ref: None,
    }
}

/// Abort response for an operation that never started because the repository
/// state drifted mid-batch (HEAD / dirty tree / config changed since
/// capture). The operation was NOT executed; the batch is flagged
/// `stale_snapshot` so clients never persist results spanning two repository
/// states. The response preserves the one-response-per-input-operation
/// cardinality, like [`cancelled_response`], but with a distinct code.
fn stale_abort_response(id: String) -> OperationResponse {
    OperationResponse {
        id,
        ok: false,
        result: None,
        error: Some(serde_json::json!({
            "code": err::E_STALE_SNAPSHOT,
            "message": "operation aborted: repository state changed mid-batch",
        })),
        truncated: false,
        artifact_ref: None,
    }
}

#[allow(clippy::too_many_arguments)]
// The op, its execution context (cwd/snapshot/AST cache), the cache context
// with its state probe, and the batch output-budget/state gates are all
// independent inputs; bundling them would obscure the hot path.
fn run_operation(
    op: &BatchOperation,
    cwd: Option<&str>,
    snapshot: Option<&IndexSnapshot>,
    cache: &AstCache,
    cache_ctx: Option<&QueryCacheContext>,
    probe: Option<&dyn BatchStateProbe>,
    stale_snapshot: bool,
    state_changed: &mut bool,
    output_budget: usize,
) -> (OperationResponse, usize) {
    let id = op.id.clone();
    // The whole-batch preflight in execute_batch_with_probe has already
    // validated that this op is a known, read-only, batchable operation;
    // invalid ops reject the ENTIRE batch before any operation runs. The
    // descriptor is only consulted here for its output bound and
    // negative-cache eligibility.
    let descriptor = tool_descriptor(&op.op).expect("preflight validated the operation");
    // Output bound (Phase 5): the effective limit is the descriptor's
    // maximum_output_bytes, further capped by the remaining batch budget so
    // the cumulative payload stays inside the daemon wire frame.
    let descriptor_limit = descriptor.maximum_output_bytes;
    let effective_limit = descriptor_limit.min(output_budget);

    // Query cache: serve Repository-cacheable ops from disk when the key
    // matches the current repository state. The key is `None` for ops that
    // are not cacheable or opted out via `no_cache`. Negative-cache-eligible
    // ops check the negative namespace first (definitive-empty results only).
    // Cache reads are skipped entirely once the repository state drifted
    // mid-batch: a cached entry was keyed on the captured state and would
    // otherwise mix results from two repository states in one response.
    let cache_key = cache_ctx.and_then(|ctx| ctx.key_for(op));
    if let (Some(ctx), Some(key)) = (&cache_ctx, &cache_key) {
        // Revalidate the captured repository state before reusing any cached
        // result: a mid-batch mutation must never mix cached results from the
        // captured state with fresh results from the new state.
        if !stale_snapshot && !*state_changed {
            if let Some(p) = probe {
                if !p.state_unchanged() {
                    *state_changed = true;
                }
            }
        }
        if !stale_snapshot && !*state_changed {
            let negative_eligible = descriptor.negative_cache_eligible;
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
                // bounds before returning (descriptor limits can change). A
                // cached result must still pass the final state-commit
                // barrier after reading and before acceptance or artifact
                // spill: a mutation between the read gate and this point must
                // discard the cached value (never serve cross-state data).
                let artifact_dir = cache_ctx.map(|c| c.cache.state_dir());
                return commit_result(
                    id,
                    value,
                    effective_limit,
                    artifact_dir,
                    None,
                    probe,
                    stale_snapshot,
                    state_changed,
                );
            }
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
            // Post-execution state revalidation: a mid-batch mutation that
            // occurred while the operation was running must invalidate the
            // result. The operation began under the captured state, but the
            // repository may have changed before the result was produced.
            // Discard the result, mark the batch stale, and return
            // E_STALE_SNAPSHOT so clients never persist cross-state results.
            if !stale_snapshot && !*state_changed {
                if let Some(p) = probe {
                    if !p.state_unchanged() {
                        *state_changed = true;
                    }
                }
            }
            if stale_snapshot || *state_changed {
                return (
                    OperationResponse {
                        id,
                        ok: false,
                        result: None,
                        error: Some(serde_json::json!({
                            "code": err::E_STALE_SNAPSHOT,
                            "message": "operation result discarded: repository state changed during execution",
                        })),
                        truncated: false,
                        artifact_ref: None,
                    },
                    0,
                );
            }
            // Commit the computed value under the final state-commit barrier
            // (commit_result): serialized into provisional cache/artifact
            // data, one last repository-state check, then atomic activation
            // of the cache entry and/or artifact, then response acceptance.
            // Definitive-empty outcomes of negative-cache-eligible ops go to
            // the negative namespace (TTL-bounded); everything else to the
            // positive namespace. The cache always stores the FULL payload;
            // truncation is a response-time concern.
            let artifact_dir = cache_ctx.map(|c| c.cache.state_dir());
            let cache_write = cache_ctx
                .as_ref()
                .zip(cache_key.as_deref())
                .map(|(ctx, key)| (*ctx, key, is_definitive_empty(&op.op, &value)));
            commit_result(
                id,
                value,
                effective_limit,
                artifact_dir,
                cache_write,
                probe,
                stale_snapshot,
                state_changed,
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

/// Commit an operation result under the final state-commit barrier.
///
/// Lifecycle (mirrors the TS fallback `commitFallbackResult`):
///   execute into provisional memory (done by the caller)
///   → post-operation state check (done by the caller)
///   → serialize into provisional bytes
///   → prepare provisional cache/artifact data (temp artifact written + fsync,
///     NOT yet visible)
///   → FINAL state check
///   → atomically activate cache entry and/or artifact (rename)
///   → accept operation response
///
/// Hard guarantees:
/// - No cache entry is visible before the final state check.
/// - No artifact is visible before the final state check.
/// - No successful response is accepted before the final state check.
/// - A state change at any point before activation converts the operation to
///   E_STALE_SNAPSHOT and removes any provisional temp files.
/// - The cache always stores the FULL payload; truncation is a response-time
///   concern.
///
/// `cache_write` carries the (context, key, negative-eligible) triple when the
/// computed result should be persisted. `None` means the value came from the
/// cache (a cache hit is never re-written).
#[allow(clippy::too_many_arguments)]
fn commit_result(
    id: String,
    value: Value,
    limit: usize,
    artifact_base: Option<&Path>,
    cache_write: Option<(&QueryCacheContext, &str, bool)>,
    probe: Option<&dyn BatchStateProbe>,
    stale_snapshot: bool,
    state_changed: &mut bool,
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

    // Prepare provisional artifact data when the payload exceeds the bound.
    // The temp file is written and fsynced but NOT renamed: it becomes visible
    // only after the final state check passes (activation below).
    let mut provisional: Option<PreparedArtifact> = None;
    if used > limit {
        let dir = artifact_base
            .map(|p| p.join("artifacts"))
            .unwrap_or_else(|| std::env::temp_dir().join("fdx-batch-artifacts"));
        let content_hash = sha256_hex(&bytes);
        let file_name = artifact_file_name(&id, &content_hash);
        let final_path = dir.join(&file_name);
        match prepare_artifact(&final_path, &bytes) {
            Ok(prepared) => provisional = Some(prepared),
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
        }
    }

    // FINAL state check: the commit barrier. A repository mutation detected
    // here — after computation, after cache/artifact preparation — discards
    // the result (E_STALE_SNAPSHOT) and removes any provisional files.
    if !stale_snapshot && !*state_changed {
        if let Some(p) = probe {
            if !p.state_unchanged() {
                *state_changed = true;
            }
        }
    }
    if stale_snapshot || *state_changed {
        if let Some(p) = &provisional {
            let _ = p.discard();
        }
        return (
            OperationResponse {
                id,
                ok: false,
                result: None,
                error: Some(serde_json::json!({
                    "code": err::E_STALE_SNAPSHOT,
                    "message": "operation result discarded: repository state changed during execution",
                })),
                truncated: false,
                artifact_ref: None,
            },
            used,
        );
    }

    // Activate the cache entry (only after the final check). The cache write
    // itself is atomic (temp sibling + rename inside QueryCache), so no reader
    // observes a partial entry and nothing is visible before this point.
    if let Some((ctx, key, negative)) = cache_write {
        if negative {
            ctx.cache.put_negative(key, &bytes);
        } else {
            ctx.cache.put(key, &bytes);
        }
    }

    // Activate the artifact (atomic rename). On a rename race the winner's
    // file is verified (SHA-256 + byte size) and reused only when identical;
    // conflicting content fails closed and the losing temp is removed.
    let artifact_ref = match provisional {
        Some(p) => match p.activate(&bytes) {
            Ok(path) => Some(path),
            Err(e) => {
                let _ = p.discard();
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
        },
        None => None,
    };

    if used <= limit {
        (
            OperationResponse {
                id,
                ok: true,
                result: Some(value),
                error: None,
                truncated: false,
                artifact_ref: None,
            },
            used,
        )
    } else {
        let content_hash = sha256_hex(&bytes);
        let artifact_ref = artifact_ref.unwrap_or_default();
        (
            OperationResponse {
                id,
                ok: true,
                result: Some(serde_json::json!({
                    "truncated": true,
                    "artifactRef": artifact_ref,
                    "byteCount": used,
                    "limitBytes": limit,
                    "contentHash": content_hash,
                })),
                error: None,
                truncated: true,
                artifact_ref: Some(artifact_ref),
            },
            used,
        )
    }
}

/// A provisional artifact prepared for atomic activation: the temp file holds
/// the complete, fsynced payload but is NOT yet visible at the final path.
struct PreparedArtifact {
    temp_path: PathBuf,
    final_path: PathBuf,
    content_hash: String,
}

impl PreparedArtifact {
    /// Remove the provisional temp file (best-effort). Called on stale
    /// detection or any failure before activation. No-op when the artifact is
    /// a reuse of an already-published file (temp == final).
    fn discard(&self) -> Result<(), String> {
        if self.temp_path == self.final_path {
            return Ok(());
        }
        std::fs::remove_file(&self.temp_path).map_err(|e| {
            format!(
                "failed to remove provisional artifact temp {}: {e}",
                self.temp_path.display()
            )
        })
    }

    /// Atomically activate the artifact: rename the temp file to the final
    /// content-addressed path. When the artifact is a reuse of an
    /// already-published correct file (temp == final), this is a no-op.
    /// When another writer already activated the final path, the winner's
    /// file is read and verified (SHA-256 AND byte size); it is reused only
    /// when both match. Conflicting content or unexpected errors fail closed.
    /// The losing temp file is always removed.
    fn activate(&self, bytes: &[u8]) -> Result<String, String> {
        if self.temp_path == self.final_path {
            // Reuse case: the correct artifact is already published.
            return Ok(self.final_path.to_string_lossy().into_owned());
        }
        match std::fs::rename(&self.temp_path, &self.final_path) {
            Ok(()) => Ok(self.final_path.to_string_lossy().into_owned()),
            Err(rename_err) => {
                // Rename lost to a concurrent writer (or an unexpected error).
                // Read the final artifact and verify identity before reuse.
                let read = std::fs::read(&self.final_path);
                let _ = self.discard();
                match read {
                    Ok(existing)
                        if sha256_hex(&existing) == self.content_hash
                            && existing.len() == bytes.len() =>
                    {
                        // Identical content: safely reuse the winner.
                        Ok(self.final_path.to_string_lossy().into_owned())
                    }
                    Ok(_) => Err(format!(
                        "artifact path already exists with different content: {}",
                        self.final_path.display()
                    )),
                    Err(read_err) => Err(format!(
                        "failed to rename artifact: {rename_err}; final unreadable: {read_err}"
                    )),
                }
            }
        }
    }
}

/// Prepare a provisional artifact: write `bytes` to a unique sibling temp file
/// (same directory, `create_new` exclusive) and fsync it. If `final_path`
/// already exists with identical content the file is reused (no temp write);
/// if it exists with different content the write fails closed. Only ENOENT
/// permits creation to proceed — permission, I/O, corruption, and unexpected
/// read errors all fail closed.
fn prepare_artifact(final_path: &Path, bytes: &[u8]) -> Result<PreparedArtifact, String> {
    let content_hash = sha256_hex(bytes);
    // Reuse an existing correct artifact (content-addressed deduplication).
    match std::fs::read(final_path) {
        Ok(existing) if sha256_hex(&existing) == content_hash => {
            // Identical content already published: reuse it. We still return a
            // PreparedArtifact whose temp is not written; `activate` must be
            // skipped for the reuse case, so signal reuse via a temp path that
            // does not exist yet is WRONG — instead, mark reuse by writing no
            // temp and returning an artifact whose activation is a no-op.
            return Ok(PreparedArtifact {
                temp_path: final_path.to_path_buf(),
                final_path: final_path.to_path_buf(),
                content_hash,
            });
        }
        Ok(_) => {
            return Err(format!(
                "artifact path already exists with different content: {}",
                final_path.display()
            ));
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(format!(
                "failed to read existing artifact: {}: {e}",
                final_path.display()
            ));
        }
    }

    if let Some(parent) = final_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create artifact dir: {e}"))?;
    }

    // Exclusive sibling temp creation (O_CREAT|O_EXCL via create_new). The
    // temp name embeds a random nonce so it cannot be guessed or shared
    // unsafely, and create_new guarantees we never truncate another writer's
    // temp file.
    let mut attempts = 0;
    loop {
        if attempts >= 100 {
            return Err("too many temp file collisions".into());
        }
        let temp_path = unique_temp_path(final_path, attempts);
        match std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
        {
            Ok(mut file) => {
                if let Err(e) = file.write_all(bytes) {
                    let _ = std::fs::remove_file(&temp_path);
                    return Err(format!("failed to write temp artifact: {e}"));
                }
                if let Err(e) = file.sync_all() {
                    let _ = std::fs::remove_file(&temp_path);
                    return Err(format!("failed to sync temp artifact: {e}"));
                }
                drop(file);
                return Ok(PreparedArtifact {
                    temp_path,
                    final_path: final_path.to_path_buf(),
                    content_hash,
                });
            }
            Err(_) => {
                attempts += 1;
                continue;
            }
        }
    }
}

/// Single-shot atomic artifact write: prepare a provisional artifact and
/// immediately activate it (no separate final state check — callers that
/// need the state-commit barrier must use `prepare_artifact` + `activate`
/// explicitly around their final check). Reuses an existing correct file,
/// fails closed on conflicts, and wins/loses rename races safely.
#[cfg(test)]
fn atomic_write_artifact(final_path: &Path, bytes: &[u8]) -> Result<String, String> {
    let prepared = prepare_artifact(final_path, bytes)?;
    prepared.activate(bytes)
}

/// A sibling temp path in the same directory as `final_path` (same filesystem
/// for the atomic rename), with a random nonce so concurrent writers never
/// collide on a shared guessable name.
fn unique_temp_path(final_path: &Path, attempt: usize) -> PathBuf {
    let file_name = final_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("artifact");
    let parent = final_path.parent().unwrap_or_else(|| Path::new("."));
    // The nonce is combined with the attempt counter; create_new (O_EXCL)
    // guarantees exclusivity regardless of nonce uniqueness.
    let nonce = format!("{:x}", fast_nonce());
    parent.join(format!(".{file_name}.{nonce}.{attempt}.tmp"))
}

/// Cheap unpredictable nonce for temp file names (time + address entropy).
fn fast_nonce() -> u64 {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    t ^ ((std::process::id() as u64) << 32)
}

/// SHA-256 hex digest of a byte slice (used for artifact content integrity).
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(bytes);
    digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

/// Make an op id safe to use as a file name (ids are client-chosen and may
/// contain path separators or other characters that would escape the artifact
/// directory). The safe prefix is bounded to 32 characters to keep the final
/// filename within platform limits.
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
    // Bound the prefix so the final filename stays well under the 255-byte
    // per-component limit: prefix (32) + op-id-hash (64) + content-hash (64)
    // + separators (2) + extension (5) = 167 bytes max.
    if out.len() > 32 {
        out.truncate(32);
    }
    out
}

/// Content-addressed artifact file name for an op id.
///
/// Format: `<safe-prefix>-<op-id-hash>-<content-hash>.json`
///
/// - `safe-prefix`: bounded sanitized operation ID (max 32 chars)
/// - `op-id-hash`: full SHA-256 of the operation ID (guarantees distinct IDs
///   never collide even when their sanitized prefixes are identical)
/// - `content-hash`: full SHA-256 of the artifact content (guarantees the
///   same operation with different content never overwrites an existing file,
///   and concurrent batches with the same ID but different content collide
///   safely)
///
/// The content hash also enables safe reuse: if the final content-addressed
/// path already exists and its content hash matches, the existing file is
/// reused; if it conflicts, the write fails closed.
fn artifact_file_name(id: &str, content_hash: &str) -> String {
    let prefix = sanitize_artifact_name(id);
    let op_id_hash = sha256_hex(id.as_bytes());
    format!("{prefix}-{op_id_hash}-{content_hash}.json")
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
    fn invalid_ops_reject_the_whole_batch_before_any_execution() {
        // Unknown, non-read-only, and non-batchable ops are whole-batch
        // rejections: no operation executes when any op is invalid.
        for ops in [
            vec![op("1", "frobnicate", serde_json::json!({}))],
            vec![op("1", "index.refresh", serde_json::json!({}))],
            vec![op("1", "capabilities.query", serde_json::json!({}))],
        ] {
            let err = execute_batch(&ops, None, None, false).unwrap_err();
            assert_eq!(err.code, err::E_BAD_REQUEST);
        }
        // A valid op alongside an invalid op is NOT executed: the whole batch
        // is rejected, so the valid op never runs (zero execution).
        let ops = vec![
            op(
                "ok1",
                "read",
                serde_json::json!({ "file": "a.txt", "mode": "raw" }),
            ),
            op("bad1", "frobnicate", serde_json::json!({})),
        ];
        let err = execute_batch(&ops, None, None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("unknown batch operation 'frobnicate'"));
    }

    #[test]
    fn unknown_and_mutating_ops_reject_the_whole_batch() {
        let ops = vec![
            op("1", "frobnicate", serde_json::json!({})),
            op("2", "index.refresh", serde_json::json!({})),
        ];
        let err = execute_batch(&ops, None, None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("frobnicate"));
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
        assert_eq!(
            resp.responses.len(),
            2,
            "one response per input operation, even under fail-fast"
        );
        assert!(!resp.responses[0].ok, "first op failed");
        assert_eq!(resp.responses[0].id, "1");
        // The unstarted op is cancelled — never executed, never a real error.
        assert!(!resp.responses[1].ok);
        assert_eq!(resp.responses[1].id, "2");
        let err = resp.responses[1].error.as_ref().expect("cancelled error");
        assert_eq!(err["code"], err::E_CANCELLED);
        assert_eq!(err["message"], "operation cancelled by fail-fast");
    }

    #[test]
    fn fail_fast_preserves_ids_and_order_for_all_ops() {
        let tmp = tempfile::tempdir().unwrap();
        let ops = vec![
            op("a", "read", serde_json::json!({ "file": "missing.txt" })),
            op("b", "read", serde_json::json!({ "file": "missing-2.txt" })),
            op("c", "read", serde_json::json!({ "file": "missing-3.txt" })),
            op("d", "read", serde_json::json!({ "file": "missing-4.txt" })),
        ];
        let resp = execute_batch(&ops, tmp.path().to_str(), None, true).unwrap();
        let ids: Vec<&str> = resp.responses.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c", "d"], "IDs preserved in input order");
        assert_eq!(resp.responses.len(), ops.len(), "cardinality preserved");
        assert!(resp.responses[1..].iter().all(|r| {
            r.error
                .as_ref()
                .map(|e| e["code"].as_str() == Some(err::E_CANCELLED))
                == Some(true)
        }));
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

    /// Scripted state probe: reports "unchanged" for the first `flip_after`
    /// calls, then "changed" forever — simulating a mid-batch mutation.
    struct ScriptedProbe {
        calls: std::sync::atomic::AtomicUsize,
        flip_after: usize,
    }

    impl BatchStateProbe for ScriptedProbe {
        fn state_unchanged(&self) -> bool {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) < self.flip_after
        }
    }

    #[test]
    fn mid_batch_state_change_marks_stale_and_aborts_remaining_ops() {
        let _guard = CACHE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os(crate::index::paths::INDEX_DIR_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::env::set_var(crate::index::paths::INDEX_DIR_ENV, state.path());

        std::fs::write(tmp.path().join("a.txt"), "alpha\n").unwrap();
        std::fs::write(tmp.path().join("b.txt"), "beta\n").unwrap();
        git_init(tmp.path());
        let cwd = tmp.path().to_str().unwrap();

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

        // The probe stays unchanged through op1 (pre-op check + read gate +
        // write gate + post-execution check: calls 0-3), then flips at op2's
        // pre-op check (call 4): op1's entry is written, op2 is ABORTED (never
        // executed), and the response reports staleSnapshot.
        let probe = ScriptedProbe {
            calls: std::sync::atomic::AtomicUsize::new(0),
            flip_after: 4,
        };
        let resp = execute_batch_with_probe(&ops, Some(cwd), None, false, Some(&probe)).unwrap();
        assert!(resp.stale_snapshot, "mid-batch mutation must flag stale");
        assert!(resp.responses[0].ok);
        assert!(
            !resp.responses[1].ok,
            "remaining ops abort on drift instead of executing"
        );
        assert_eq!(
            resp.responses[1].error.as_ref().unwrap()["code"],
            err::E_STALE_SNAPSHOT,
            "drift abort uses the dedicated E_STALE_SNAPSHOT code"
        );
        assert_eq!(
            cache_entry_count(state.path()),
            1,
            "only the op whose state matched at write time is cached"
        );

        match prev {
            Some(v) => std::env::set_var(crate::index::paths::INDEX_DIR_ENV, v),
            None => std::env::remove_var(crate::index::paths::INDEX_DIR_ENV),
        }
    }

    #[test]
    fn drift_aborts_all_remaining_ops_and_preserves_cardinality() {
        let _guard = CACHE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os(crate::index::paths::INDEX_DIR_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::env::set_var(crate::index::paths::INDEX_DIR_ENV, state.path());

        std::fs::write(tmp.path().join("a.txt"), "alpha\n").unwrap();
        git_init(tmp.path());
        let cwd = tmp.path().to_str().unwrap();

        // Probe flips at the first op: the whole batch is aborted with zero
        // execution — every op returns E_STALE_SNAPSHOT, ids preserved.
        let ops = vec![
            op(
                "a",
                "read",
                serde_json::json!({ "file": "a.txt", "mode": "raw" }),
            ),
            op(
                "b",
                "read",
                serde_json::json!({ "file": "a.txt", "mode": "raw" }),
            ),
            op(
                "c",
                "read",
                serde_json::json!({ "file": "a.txt", "mode": "raw" }),
            ),
        ];
        let flipped = ScriptedProbe {
            calls: std::sync::atomic::AtomicUsize::new(0),
            flip_after: 0,
        };
        let resp = execute_batch_with_probe(&ops, Some(cwd), None, false, Some(&flipped)).unwrap();
        assert!(resp.stale_snapshot);
        let ids: Vec<&str> = resp.responses.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c"], "IDs preserved in input order");
        assert_eq!(resp.responses.len(), ops.len(), "cardinality preserved");
        assert!(resp.responses.iter().all(|r| {
            !r.ok
                && r.error
                    .as_ref()
                    .map(|e| e["code"].as_str() == Some(err::E_STALE_SNAPSHOT))
                    == Some(true)
        }));
        assert_eq!(
            cache_entry_count(state.path()),
            0,
            "zero execution under drift: nothing is cached"
        );

        match prev {
            Some(v) => std::env::set_var(crate::index::paths::INDEX_DIR_ENV, v),
            None => std::env::remove_var(crate::index::paths::INDEX_DIR_ENV),
        }
    }

    #[test]
    fn mid_batch_state_change_never_reuses_cached_results() {
        let _guard = CACHE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os(crate::index::paths::INDEX_DIR_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::env::set_var(crate::index::paths::INDEX_DIR_ENV, state.path());

        std::fs::write(tmp.path().join("a.txt"), "alpha\n").unwrap();
        git_init(tmp.path());
        let cwd = tmp.path().to_str().unwrap();
        let read_a = || {
            vec![op(
                "r1",
                "read",
                serde_json::json!({ "file": "a.txt", "mode": "raw" }),
            )]
        };

        // Prime the cache with the captured-state result (probe never flips).
        let steady = ScriptedProbe {
            calls: std::sync::atomic::AtomicUsize::new(0),
            flip_after: usize::MAX,
        };
        execute_batch_with_probe(&read_a(), Some(cwd), None, false, Some(&steady)).unwrap();
        assert_eq!(cache_entry_count(state.path()), 1);

        // Now the state flips at the pre-op check: the op is ABORTED before
        // execution — the cached entry is never reused, nothing is computed,
        // and nothing is written (zero execution on drift).
        let flipped = ScriptedProbe {
            calls: std::sync::atomic::AtomicUsize::new(0),
            flip_after: 0,
        };
        let resp =
            execute_batch_with_probe(&read_a(), Some(cwd), None, false, Some(&flipped)).unwrap();
        assert!(resp.stale_snapshot);
        assert!(
            !resp.responses[0].ok,
            "op aborted on drift, never executed, never served from cache"
        );
        assert_eq!(
            resp.responses[0].error.as_ref().unwrap()["code"],
            err::E_STALE_SNAPSHOT
        );
        assert_eq!(
            cache_entry_count(state.path()),
            1,
            "no new cache write under a changed state"
        );

        match prev {
            Some(v) => std::env::set_var(crate::index::paths::INDEX_DIR_ENV, v),
            None => std::env::remove_var(crate::index::paths::INDEX_DIR_ENV),
        }
    }

    #[test]
    fn fail_fast_cancelled_ops_never_touch_the_cache() {
        let _guard = CACHE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os(crate::index::paths::INDEX_DIR_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::env::set_var(crate::index::paths::INDEX_DIR_ENV, state.path());

        std::fs::write(tmp.path().join("a.txt"), "alpha\n").unwrap();
        git_init(tmp.path());
        let cwd = tmp.path().to_str().unwrap();

        let ops = vec![
            op(
                "r1",
                "read",
                serde_json::json!({ "file": "a.txt", "mode": "raw" }),
            ),
            op(
                "r2",
                "read",
                serde_json::json!({ "file": "missing.txt", "mode": "raw" }),
            ),
            op(
                "r3",
                "read",
                serde_json::json!({ "file": "a.txt", "mode": "raw" }),
            ),
        ];
        let resp = execute_batch(&ops, Some(cwd), None, true).unwrap();
        assert!(resp.failed_fast);
        assert_eq!(
            resp.responses.len(),
            3,
            "cardinality preserved under fail-fast"
        );
        assert!(resp.responses[0].ok);
        assert!(!resp.responses[1].ok);
        assert_eq!(
            resp.responses[2].error.as_ref().unwrap()["code"],
            err::E_CANCELLED,
            "the unstarted op is cancelled, not executed"
        );
        assert_eq!(
            cache_entry_count(state.path()),
            1,
            "only the completed op may cache; cancelled ops never write"
        );

        match prev {
            Some(v) => std::env::set_var(crate::index::paths::INDEX_DIR_ENV, v),
            None => std::env::remove_var(crate::index::paths::INDEX_DIR_ENV),
        }
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
    fn non_batchable_op_rejects_the_whole_batch() {
        let tmp = tempfile::tempdir().unwrap();
        let ops = vec![op("c1", "capabilities.query", serde_json::json!({}))];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("does not support batching"));
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

    #[test]
    fn artifact_file_names_are_collision_resistant() {
        // Distinct ids that sanitize to the SAME base name (e.g. "a/b" and
        // "a:b" → "a_b") must still produce distinct artifact files, so two
        // truncated ops in one batch can never overwrite each other.
        let content_hash = sha256_hex(b"test-content");
        let a = artifact_file_name("a/b", &content_hash);
        let b = artifact_file_name("a:b", &content_hash);
        assert_ne!(a, b, "sanitized-colliding ids must not collide");
        assert!(a.ends_with(".json"));
        assert!(b.ends_with(".json"));
        // Each name embeds the full op-id hash and content hash.
        assert!(a.starts_with("a_b-") && a.len() > "a_b-".len() + ".json".len());
        // Deterministic for the same id and content.
        assert_eq!(
            artifact_file_name("grep-1", &content_hash),
            artifact_file_name("grep-1", &content_hash)
        );
        // Safe file name: no path separators.
        assert!(!artifact_file_name("../evil/op id", &content_hash).contains('/'));
    }

    // ─── Adversarial tests for production contract gaps ─────────────────────

    #[test]
    fn parameter_preflight_rejects_invalid_read_params() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("a.txt"), "alpha\n").unwrap();

        // Missing file parameter.
        let ops = vec![op("r1", "read", serde_json::json!({ "mode": "raw" }))];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("read requires 'file'"));

        // Empty file parameter.
        let ops = vec![op(
            "r2",
            "read",
            serde_json::json!({ "file": "", "mode": "raw" }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("must not be empty"));

        // Invalid mode parameter.
        let ops = vec![op(
            "r3",
            "read",
            serde_json::json!({ "file": "a.txt", "mode": "invalid" }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("invalid read mode"));

        // NUL byte in file parameter.
        let ops = vec![op(
            "r4",
            "read",
            serde_json::json!({ "file": "a.txt\0b.txt", "mode": "raw" }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("embedded NUL"));
    }

    #[test]
    fn parameter_preflight_rejects_invalid_grep_params() {
        let tmp = tempfile::tempdir().unwrap();

        // Missing pattern parameter.
        let ops = vec![op("g1", "grep", serde_json::json!({ "paths": ["."] }))];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("grep requires 'pattern'"));

        // Empty pattern parameter.
        let ops = vec![op(
            "g2",
            "grep",
            serde_json::json!({ "pattern": "", "paths": ["."] }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("must not be empty"));

        // Invalid regex pattern.
        let ops = vec![op(
            "g3",
            "grep",
            serde_json::json!({ "pattern": "[invalid", "paths": ["."] }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("not a valid regex"));

        // Excessive contextLines (camelCase on the wire).
        let ops = vec![op(
            "g4",
            "grep",
            serde_json::json!({ "pattern": "x", "paths": ["."], "contextLines": 5 }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err
            .message
            .contains("grep 'context_lines' must be <= 3, got 5"));

        // Excessive maxMatches (camelCase on the wire).
        let ops = vec![op(
            "g5",
            "grep",
            serde_json::json!({ "pattern": "x", "paths": ["."], "maxMatches": 300 }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err
            .message
            .contains("grep 'max_matches' must be in 1..=200, got 300"));

        // NUL byte in paths.
        let ops = vec![op(
            "g6",
            "grep",
            serde_json::json!({ "pattern": "x", "paths": ["a\0b"] }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("embedded NUL"));
    }

    #[test]
    fn parameter_preflight_rejects_invalid_search_params() {
        let tmp = tempfile::tempdir().unwrap();

        // Missing pattern parameter.
        let ops = vec![op("s1", "search", serde_json::json!({ "paths": ["."] }))];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("search requires 'pattern'"));

        // Invalid kind_filter (camelCase on the wire).
        let ops = vec![op(
            "s2",
            "search",
            serde_json::json!({ "pattern": "x", "paths": ["."], "kindFilter": "invalid" }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err
            .message
            .contains("search 'kind_filter' is not supported: invalid"));

        // Excessive max_matches.
        let ops = vec![op(
            "s3",
            "search",
            serde_json::json!({ "pattern": "x", "paths": ["."], "maxMatches": 600 }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err
            .message
            .contains("search 'max_matches' must be in 1..=500, got 600"));
    }

    #[test]
    fn parameter_preflight_rejects_invalid_outline_params() {
        let tmp = tempfile::tempdir().unwrap();

        // Excessive depth (camelCase on the wire).
        let ops = vec![op(
            "o1",
            "outline",
            serde_json::json!({ "paths": ["."], "depth": 20 }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err
            .message
            .contains("outline 'depth' must be in 1..=10, got 20"));

        // Excessive minLines (camelCase on the wire).
        let ops = vec![op(
            "o2",
            "outline",
            serde_json::json!({ "paths": ["."], "minLines": 2000 }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err
            .message
            .contains("outline 'min_lines' must be in 1..=1000, got 2000"));

        // NUL byte in paths.
        let ops = vec![op(
            "o3",
            "outline",
            serde_json::json!({ "paths": ["a\0b"] }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("embedded NUL"));
    }

    #[test]
    fn parameter_preflight_rejects_invalid_impact_params() {
        let tmp = tempfile::tempdir().unwrap();

        // Empty targets.
        let ops = vec![op("i1", "impact", serde_json::json!({ "targets": [] }))];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err
            .message
            .contains("impact requires at least one 'targets' entry"));

        // Invalid direction.
        let ops = vec![op(
            "i2",
            "impact",
            serde_json::json!({ "targets": ["."], "direction": "sideways" }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("invalid impact direction"));

        // Invalid depth (camelCase on the wire).
        let ops = vec![op(
            "i3",
            "impact",
            serde_json::json!({ "targets": ["."], "depth": 5 }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("impact 'depth' must be 1, got 5"));

        // NUL byte in targets.
        let ops = vec![op(
            "i4",
            "impact",
            serde_json::json!({ "targets": ["a\0b"] }),
        )];
        let err = execute_batch(&ops, tmp.path().to_str(), None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("embedded NUL"));
    }

    #[test]
    fn parameter_preflight_rejects_invalid_tests_for_params() {
        // Missing source parameter.
        let ops = vec![op("t1", "testsFor", serde_json::json!({}))];
        let err = execute_batch(&ops, None, None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("testsFor requires 'source'"));

        // Empty source parameter.
        let ops = vec![op("t2", "testsFor", serde_json::json!({ "source": "" }))];
        let err = execute_batch(&ops, None, None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("must not be empty"));

        // NUL byte in source.
        let ops = vec![op(
            "t3",
            "testsFor",
            serde_json::json!({ "source": "foo\0bar" }),
        )];
        let err = execute_batch(&ops, None, None, false).unwrap_err();
        assert_eq!(err.code, err::E_BAD_REQUEST);
        assert!(err.message.contains("embedded NUL"));
    }

    #[test]
    fn post_execution_drift_discards_result_and_marks_stale() {
        let _guard = CACHE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os(crate::index::paths::INDEX_DIR_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::env::set_var(crate::index::paths::INDEX_DIR_ENV, state.path());

        std::fs::write(tmp.path().join("a.txt"), "alpha\n").unwrap();
        git_init(tmp.path());
        let cwd = tmp.path().to_str().unwrap();

        let ops = vec![op(
            "r1",
            "read",
            serde_json::json!({ "file": "a.txt", "mode": "raw" }),
        )];

        // The probe flips at call 2 (post-execution check): the operation
        // executes successfully but its result is discarded because the
        // repository state changed during execution.
        // Probe calls per op: pre-op check (0), cache read check (1), post-execution check (2).
        let probe = ScriptedProbe {
            calls: std::sync::atomic::AtomicUsize::new(0),
            flip_after: 2,
        };
        let resp = execute_batch_with_probe(&ops, Some(cwd), None, false, Some(&probe)).unwrap();
        assert!(resp.stale_snapshot, "post-execution drift must flag stale");
        assert!(
            !resp.responses[0].ok,
            "result must be discarded on post-execution drift"
        );
        assert_eq!(
            resp.responses[0].error.as_ref().unwrap()["code"],
            err::E_STALE_SNAPSHOT,
            "post-execution drift uses E_STALE_SNAPSHOT"
        );
        assert_eq!(
            cache_entry_count(state.path()),
            0,
            "discarded result must not be cached"
        );

        match prev {
            Some(v) => std::env::set_var(crate::index::paths::INDEX_DIR_ENV, v),
            None => std::env::remove_var(crate::index::paths::INDEX_DIR_ENV),
        }
    }

    #[test]
    fn atomic_artifact_write_fails_closed_on_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("artifacts");
        std::fs::create_dir_all(&dir).unwrap();

        let content = b"hello world";
        let content_hash = sha256_hex(content);
        let file_name = artifact_file_name("test-op", &content_hash);
        let final_path = dir.join(&file_name);

        // First write succeeds.
        atomic_write_artifact(&final_path, content).unwrap();
        assert!(final_path.exists());

        // Second write with different content fails closed (content-addressed
        // collision: same path, different hash).
        let different_content = b"goodbye world";
        let result = atomic_write_artifact(&final_path, different_content);
        assert!(result.is_err(), "conflicting content must fail closed");

        // Original file is untouched.
        let existing = std::fs::read(&final_path).unwrap();
        assert_eq!(
            existing, content,
            "original artifact must not be overwritten"
        );
    }

    #[test]
    fn atomic_artifact_write_deduplicates_identical_content() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("artifacts");
        std::fs::create_dir_all(&dir).unwrap();

        let content = b"duplicate content";
        let content_hash = sha256_hex(content);
        let file_name = artifact_file_name("test-op", &content_hash);
        let final_path = dir.join(&file_name);

        // First write creates the file.
        atomic_write_artifact(&final_path, content).unwrap();
        let mtime1 = std::fs::metadata(&final_path).unwrap().modified().unwrap();

        // Second write with identical content is a no-op (deduplication).
        std::thread::sleep(std::time::Duration::from_millis(10));
        atomic_write_artifact(&final_path, content).unwrap();
        let mtime2 = std::fs::metadata(&final_path).unwrap().modified().unwrap();

        assert_eq!(
            mtime1, mtime2,
            "identical content must not rewrite the file"
        );
    }

    // ─── Final state-commit barrier (P1 #2) ────────────────────────────────

    #[test]
    fn drift_at_final_barrier_discards_result_and_writes_no_cache() {
        // The probe stays unchanged through pre-op (0), cache read gate (1)
        // and post-execution check (2), then flips at the FINAL commit barrier
        // (3): the computation succeeded but the state changed after it,
        // before cache/artifact activation. The result is discarded, no cache
        // entry becomes visible, and the batch is flagged stale.
        let _guard = CACHE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os(crate::index::paths::INDEX_DIR_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::env::set_var(crate::index::paths::INDEX_DIR_ENV, state.path());

        std::fs::write(tmp.path().join("a.txt"), "alpha\n").unwrap();
        git_init(tmp.path());
        let cwd = tmp.path().to_str().unwrap();

        let ops = vec![op(
            "r1",
            "read",
            serde_json::json!({ "file": "a.txt", "mode": "raw" }),
        )];
        let probe = ScriptedProbe {
            calls: std::sync::atomic::AtomicUsize::new(0),
            flip_after: 3,
        };
        let resp = execute_batch_with_probe(&ops, Some(cwd), None, false, Some(&probe)).unwrap();
        assert!(resp.stale_snapshot, "final-barrier drift must flag stale");
        assert!(
            !resp.responses[0].ok,
            "result must be discarded at the final commit barrier"
        );
        assert_eq!(
            resp.responses[0].error.as_ref().unwrap()["code"],
            err::E_STALE_SNAPSHOT
        );
        assert_eq!(
            cache_entry_count(state.path()),
            0,
            "no cache entry becomes visible before the final state check"
        );

        match prev {
            Some(v) => std::env::set_var(crate::index::paths::INDEX_DIR_ENV, v),
            None => std::env::remove_var(crate::index::paths::INDEX_DIR_ENV),
        }
    }

    #[test]
    fn drift_after_cache_read_discards_cached_value() {
        // A cached value is read, then the probe flips at the final commit
        // barrier (after the read gate, before acceptance): the cached result
        // must NOT be served across a state boundary.
        let _guard = CACHE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os(crate::index::paths::INDEX_DIR_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::env::set_var(crate::index::paths::INDEX_DIR_ENV, state.path());

        std::fs::write(tmp.path().join("a.txt"), "alpha\n").unwrap();
        git_init(tmp.path());
        let cwd = tmp.path().to_str().unwrap();
        let read_a = || {
            vec![op(
                "r1",
                "read",
                serde_json::json!({ "file": "a.txt", "mode": "raw" }),
            )]
        };

        // Prime the cache under a steady state.
        let steady = ScriptedProbe {
            calls: std::sync::atomic::AtomicUsize::new(0),
            flip_after: usize::MAX,
        };
        execute_batch_with_probe(&read_a(), Some(cwd), None, false, Some(&steady)).unwrap();
        assert_eq!(cache_entry_count(state.path()), 1);

        // Now drift at the final barrier AFTER the cache read: pre-op (0) and
        // read gate (1) pass, final barrier (2) flips.
        let flipped = ScriptedProbe {
            calls: std::sync::atomic::AtomicUsize::new(0),
            flip_after: 2,
        };
        let resp =
            execute_batch_with_probe(&read_a(), Some(cwd), None, false, Some(&flipped)).unwrap();
        assert!(resp.stale_snapshot);
        assert!(
            !resp.responses[0].ok,
            "cached result must not be served across a state change"
        );
        assert_eq!(
            resp.responses[0].error.as_ref().unwrap()["code"],
            err::E_STALE_SNAPSHOT
        );
        assert_eq!(
            cache_entry_count(state.path()),
            1,
            "no new cache write on drift; the existing entry stays"
        );

        match prev {
            Some(v) => std::env::set_var(crate::index::paths::INDEX_DIR_ENV, v),
            None => std::env::remove_var(crate::index::paths::INDEX_DIR_ENV),
        }
    }

    #[test]
    fn drift_before_artifact_activation_leaves_no_artifact() {
        // An oversized result prepares a provisional artifact, then the probe
        // flips at the final commit barrier: no final artifact may become
        // visible and the provisional temp file is removed.
        let tmp = tempfile::tempdir().unwrap();
        let big = "x".repeat(300 * 1024);
        std::fs::write(tmp.path().join("big.txt"), &big).unwrap();

        // A unique op id so we can assert on OUR artifact path without
        // colliding with other tests that share the global temp artifacts dir.
        let id = "final-barrier-drift-op";
        let ops = vec![op(
            id,
            "read",
            serde_json::json!({ "file": "big.txt", "mode": "raw" }),
        )];
        // Non-git cwd → no cache context → probe is the injected one. Calls:
        // pre-op (0), post-execution (1), final barrier (2).
        let probe = ScriptedProbe {
            calls: std::sync::atomic::AtomicUsize::new(0),
            flip_after: 2,
        };
        let resp =
            execute_batch_with_probe(&ops, tmp.path().to_str(), None, false, Some(&probe)).unwrap();
        assert!(resp.stale_snapshot);
        assert!(!resp.responses[0].ok);
        assert_eq!(
            resp.responses[0].error.as_ref().unwrap()["code"],
            err::E_STALE_SNAPSHOT
        );
        assert!(resp.responses[0].artifact_ref.is_none());

        // No artifact or provisional temp for THIS op id may exist. The
        // content-addressed file name embeds the sanitized op id, and
        // provisional temps embed the final file name, so any file containing
        // our unique id string is ours.
        let artifacts_dir = std::env::temp_dir().join("fdx-batch-artifacts");
        let leftovers: Vec<_> = std::fs::read_dir(&artifacts_dir)
            .map(|e| {
                e.flatten()
                    .filter(|f| f.file_name().to_string_lossy().contains(id))
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            leftovers.is_empty(),
            "no final artifact or provisional temp may remain after stale detection: {leftovers:?}"
        );
    }

    #[test]
    fn final_envelope_drift_invalidates_accepted_responses() {
        // Every per-op check passes (pre-op, read gate, post-exec, final
        // barrier), so the response is accepted. The probe then flips at the
        // OUTER final-envelope check: the accepted success must be converted
        // to E_STALE_SNAPSHOT — the outer check is not merely a flag.
        let _guard = CACHE_ENV_LOCK.lock().unwrap();
        let prev = std::env::var_os(crate::index::paths::INDEX_DIR_ENV);

        let tmp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::env::set_var(crate::index::paths::INDEX_DIR_ENV, state.path());

        std::fs::write(tmp.path().join("a.txt"), "alpha\n").unwrap();
        git_init(tmp.path());
        let cwd = tmp.path().to_str().unwrap();

        let ops = vec![op(
            "r1",
            "read",
            serde_json::json!({ "file": "a.txt", "mode": "raw" }),
        )];
        // A single cacheable read op makes 5 probe calls: pre-op (0), read
        // gate (1), post-exec (2), final barrier (3), then the outer
        // final-envelope check (4). flip_after = 4 passes every per-op check
        // (calls 0-3 all < 4) and fails exactly at the envelope (call 4), so
        // the accepted success must be invalidated to E_STALE_SNAPSHOT.
        let envelope_probe = ScriptedProbe {
            calls: std::sync::atomic::AtomicUsize::new(0),
            flip_after: 4,
        };
        let resp =
            execute_batch_with_probe(&ops, Some(cwd), None, false, Some(&envelope_probe)).unwrap();
        assert!(resp.stale_snapshot);
        assert!(
            !resp.responses[0].ok,
            "envelope drift must invalidate the accepted response"
        );
        assert_eq!(
            resp.responses[0].error.as_ref().unwrap()["code"],
            err::E_STALE_SNAPSHOT
        );

        match prev {
            Some(v) => std::env::set_var(crate::index::paths::INDEX_DIR_ENV, v),
            None => std::env::remove_var(crate::index::paths::INDEX_DIR_ENV),
        }
    }

    // ─── Concurrent artifact publication (P1 #3) ────────────────────────────

    #[test]
    fn concurrent_artifact_writes_same_content_succeed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("artifacts");
        std::fs::create_dir_all(&dir).unwrap();
        // Artifacts hold serialized JSON payloads; use a JSON-valid body so
        // the "readers never observe partial JSON" invariant is meaningful.
        let content = serde_json::to_vec(&serde_json::json!({
            "lines": ["concurrent identical payload"],
            "byteCount": 42,
        }))
        .unwrap();
        let content_hash = sha256_hex(&content);
        let final_path = dir.join(artifact_file_name("shared-op", &content_hash));
        let path = std::sync::Arc::new(final_path.clone());

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let p = std::sync::Arc::clone(&path);
                let c = content.clone();
                std::thread::spawn(move || atomic_write_artifact(&p, &c))
            })
            .collect();
        for h in handles {
            let res = h.join().unwrap();
            assert!(res.is_ok(), "same-content writer must succeed: {res:?}");
        }
        let on_disk = std::fs::read(&final_path).unwrap();
        assert_eq!(on_disk, content, "artifact holds the full payload");
        let parsed: serde_json::Value = serde_json::from_slice(&on_disk).unwrap();
        assert_eq!(
            parsed["lines"][0], "concurrent identical payload",
            "readers observe complete, valid JSON"
        );
        // No leftover temp files after any race.
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .map(|e| {
                e.flatten()
                    .filter(|f| {
                        let name = f.file_name();
                        name.to_string_lossy().ends_with(".tmp")
                    })
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            leftovers.is_empty(),
            "temp files must be cleaned: {leftovers:?}"
        );
    }

    #[test]
    fn concurrent_artifact_writes_different_content_do_not_collide() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("artifacts");
        std::fs::create_dir_all(&dir).unwrap();

        let content_a = b"content variant A".to_vec();
        let content_b = b"content variant B".to_vec();
        let hash_a = sha256_hex(&content_a);
        let hash_b = sha256_hex(&content_b);
        let path_a = dir.join(artifact_file_name("same-id", &hash_a));
        let path_b = dir.join(artifact_file_name("same-id", &hash_b));
        assert_ne!(path_a, path_b, "different content → different paths");

        let pa = std::sync::Arc::new(path_a.clone());
        let pb = std::sync::Arc::new(path_b.clone());
        let ha = std::sync::Arc::new(path_a.clone());
        let hb = std::sync::Arc::new(path_b.clone());

        let ta = {
            let p = std::sync::Arc::clone(&pa);
            let c = content_a.clone();
            std::thread::spawn(move || atomic_write_artifact(&p, &c))
        };
        let tb = {
            let p = std::sync::Arc::clone(&pb);
            let c = content_b.clone();
            std::thread::spawn(move || atomic_write_artifact(&p, &c))
        };
        assert!(ta.join().unwrap().is_ok());
        assert!(tb.join().unwrap().is_ok());
        assert_eq!(std::fs::read(&path_a).unwrap(), content_a);
        assert_eq!(std::fs::read(&path_b).unwrap(), content_b);
        // Neither overwrote the other (both contents present on disk).
        let _ = (ha, hb);
    }

    #[test]
    fn final_rename_winner_is_verified_and_reused() {
        // Winner publishes first; the loser's rename fails (or lands after)
        // and must verify + reuse the winner instead of overwriting it.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("artifacts");
        std::fs::create_dir_all(&dir).unwrap();
        let content = b"winner content".to_vec();
        let content_hash = sha256_hex(&content);
        let final_path = dir.join(artifact_file_name("win-op", &content_hash));

        // Winner activates first.
        atomic_write_artifact(&final_path, &content).unwrap();
        let mtime = std::fs::metadata(&final_path).unwrap().modified().unwrap();

        // Loser attempts the same write; the existing correct file is reused.
        std::thread::sleep(std::time::Duration::from_millis(10));
        atomic_write_artifact(&final_path, &content).unwrap();
        let mtime2 = std::fs::metadata(&final_path).unwrap().modified().unwrap();
        assert_eq!(mtime, mtime2, "reuse must not rewrite the winner's file");
        assert_eq!(std::fs::read(&final_path).unwrap(), content);
    }

    #[test]
    fn existing_conflicting_artifact_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("artifacts");
        std::fs::create_dir_all(&dir).unwrap();
        let expected = b"expected content".to_vec();
        let conflicting = b"tampered content".to_vec();
        let hash = sha256_hex(&expected);
        let final_path = dir.join(artifact_file_name("c-op", &hash));

        // A file exists at the final path with WRONG content.
        std::fs::write(&final_path, &conflicting).unwrap();
        let res = atomic_write_artifact(&final_path, &expected);
        assert!(
            res.is_err(),
            "corrupt/conflicting artifact must fail closed"
        );
        let on_disk = std::fs::read(&final_path).unwrap();
        assert_eq!(on_disk, conflicting, "original file must not be touched");
    }

    #[test]
    fn non_enoent_read_failure_fails_closed() {
        // A directory at the final path makes the "does it exist" probe fail
        // with EISDIR (not ENOENT): creation must NOT proceed; the write must
        // fail closed rather than truncating through the directory.
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("artifacts");
        std::fs::create_dir_all(&dir).unwrap();
        let content = b"payload".to_vec();
        let hash = sha256_hex(&content);
        let final_path = dir.join(artifact_file_name("d-op", &hash));
        std::fs::create_dir_all(&final_path).unwrap();

        let res = atomic_write_artifact(&final_path, &content);
        assert!(res.is_err(), "non-ENOENT read failure must fail closed");
        assert!(final_path.is_dir(), "the directory must not be destroyed");
    }
}
