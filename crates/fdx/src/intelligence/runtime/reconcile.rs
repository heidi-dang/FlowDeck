//! Safe discovery, validation, and reconciliation of M7 .fdx/runs/*.json artifacts.

use crate::intelligence::runtime::ingest::{ingest_verification_run, MAX_RUNTIME_ARTIFACT_BYTES};
use crate::intelligence::runtime::model::{HistoryReconciliationReport, RuntimeIngestResult};
use crate::intelligence::verify::model::VerificationRun;
use rusqlite::Connection;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Discover and reconcile all valid verification run artifacts in .fdx/runs/ into SQLite.
pub fn reconcile_runs_directory(
    conn: &mut Connection,
    repo_root: &Path,
) -> Result<HistoryReconciliationReport, String> {
    let canonical_root = std::fs::canonicalize(repo_root)
        .map_err(|e| format!("cannot canonicalize repo root: {}", e))?;
    let runs_dir = canonical_root.join(".fdx").join("runs");

    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let mut report = HistoryReconciliationReport {
        reconciled_at_ms: now_ms,
        artifacts_discovered: 0,
        artifacts_imported: 0,
        artifacts_already_present: 0,
        artifacts_conflicted: 0,
        artifacts_failed: 0,
        is_complete: true,
        errors: vec![],
    };

    if !runs_dir.exists() {
        return Ok(report);
    }

    let entries = match std::fs::read_dir(&runs_dir) {
        Ok(e) => e,
        Err(e) => {
            report.is_complete = false;
            report.errors.push(format!("cannot read runs dir: {}", e));
            return Ok(report);
        }
    };

    // Deterministic sorted file collection
    let mut json_files: Vec<PathBuf> = Vec::new();
    for entry_res in entries {
        let entry = match entry_res {
            Ok(e) => e,
            Err(e) => {
                report.is_complete = false;
                report.errors.push(format!("error reading entry: {}", e));
                continue;
            }
        };

        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(e) => {
                report.is_complete = false;
                report
                    .errors
                    .push(format!("cannot read file type for {:?}: {}", path, e));
                continue;
            }
        };

        // Must be a regular file or regular symlink inside canonical runs dir
        if file_type.is_dir() {
            continue;
        }

        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        json_files.push(path);
    }

    json_files.sort();
    report.artifacts_discovered = json_files.len() as u64;

    for file_path in json_files {
        // 1. Strict symlink escape check
        let canonical_file = match std::fs::canonicalize(&file_path) {
            Ok(p) => p,
            Err(e) => {
                report.artifacts_failed += 1;
                report.is_complete = false;
                report
                    .errors
                    .push(format!("cannot canonicalize {:?}: {}", file_path, e));
                continue;
            }
        };

        if !canonical_file.starts_with(&runs_dir) {
            report.artifacts_failed += 1;
            report.is_complete = false;
            report.errors.push(format!(
                "symlink {:?} escapes runs dir {:?}",
                file_path, runs_dir
            ));
            continue;
        }

        // 2. Bound file size
        let metadata = match std::fs::metadata(&canonical_file) {
            Ok(m) => m,
            Err(e) => {
                report.artifacts_failed += 1;
                report.is_complete = false;
                report
                    .errors
                    .push(format!("cannot stat {:?}: {}", canonical_file, e));
                continue;
            }
        };

        if metadata.len() > MAX_RUNTIME_ARTIFACT_BYTES {
            report.artifacts_failed += 1;
            report.is_complete = false;
            report.errors.push(format!(
                "artifact {:?} exceeds max size bound ({} bytes)",
                canonical_file,
                metadata.len()
            ));
            continue;
        }

        // 3. Read bounded bytes
        let mut file = match File::open(&canonical_file) {
            Ok(f) => f,
            Err(e) => {
                report.artifacts_failed += 1;
                report.is_complete = false;
                report
                    .errors
                    .push(format!("cannot open {:?}: {}", canonical_file, e));
                continue;
            }
        };

        let mut raw_bytes = Vec::with_capacity(metadata.len() as usize);
        if let Err(e) = (&mut file)
            .take(MAX_RUNTIME_ARTIFACT_BYTES + 1)
            .read_to_end(&mut raw_bytes)
        {
            report.artifacts_failed += 1;
            report.is_complete = false;
            report.errors.push(format!(
                "cannot read bytes from {:?}: {}",
                canonical_file, e
            ));
            continue;
        }

        // 4. Parse VerificationRun
        let run: VerificationRun = match serde_json::from_slice(&raw_bytes) {
            Ok(r) => r,
            Err(e) => {
                report.artifacts_failed += 1;
                report.is_complete = false;
                report
                    .errors
                    .push(format!("malformed json in {:?}: {}", canonical_file, e));
                continue;
            }
        };

        // 5. Ingest
        match ingest_verification_run(conn, &run, Some(&raw_bytes)) {
            Ok(RuntimeIngestResult::Imported { .. }) => {
                report.artifacts_imported += 1;
            }
            Ok(RuntimeIngestResult::AlreadyImported { .. }) => {
                report.artifacts_already_present += 1;
            }
            Ok(RuntimeIngestResult::Conflict {
                run_id,
                existing_digest,
                incoming_digest,
            }) => {
                report.artifacts_conflicted += 1;
                report.is_complete = false;
                report.errors.push(format!(
                    "run_id conflict for {}: existing {}, incoming {}",
                    run_id, existing_digest, incoming_digest
                ));
            }
            Ok(RuntimeIngestResult::Failed { reason, .. }) => {
                report.artifacts_failed += 1;
                report.is_complete = false;
                report.errors.push(format!(
                    "ingest failed for {:?}: {}",
                    canonical_file, reason
                ));
            }
            Err(e) => {
                report.artifacts_failed += 1;
                report.is_complete = false;
                report
                    .errors
                    .push(format!("ingest error for {:?}: {}", canonical_file, e));
            }
        }
    }

    Ok(report)
}
