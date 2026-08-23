//! Verification run artifact persistence.
//!
//! Saves verification execution results to `.fdx/runs/<run_id>.json`.
//! Completely isolated from M3-M6 semantic, build, and test evidence stores.

use crate::intelligence::verify::model::VerificationRun;
use std::fs;
use std::path::{Path, PathBuf};

/// Path to run artifacts directory.
pub fn runs_dir(repo_root: &Path) -> PathBuf {
    repo_root.join(".fdx").join("runs")
}

/// Persist a verification run to `.fdx/runs/<run_id>.json`.
pub fn persist_verification_run(
    repo_root: &Path,
    run: &VerificationRun,
) -> Result<PathBuf, std::io::Error> {
    let dir = runs_dir(repo_root);
    fs::create_dir_all(&dir)?;

    let target_path = dir.join(format!("{}.json", run.run_id));
    let json_content = serde_json::to_string_pretty(run)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    fs::write(&target_path, json_content)?;
    Ok(target_path)
}

/// Load a persisted verification run by ID.
pub fn load_verification_run(
    repo_root: &Path,
    run_id: &str,
) -> Result<VerificationRun, std::io::Error> {
    let path = runs_dir(repo_root).join(format!("{}.json", run_id));
    let content = fs::read_to_string(path)?;
    serde_json::from_str(&content)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}
