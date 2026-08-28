//! Path helpers for the per-topic planning artifacts (`~/.fd-plan/<slug>/<topic>/`).
//!
//! These are a port of `src/tools/planning-state-lib.ts` in TypeScript. The two
//! implementations MUST stay in sync — drift breaks the fdx-context and
//! fdx-decisions tools which write to these paths. See `tests/fixtures/path-scheme.json`
//! for the cross-runtime parity test.

use std::path::{Path, PathBuf};

/// Maximum length for a slugified topic. Matches the TypeScript `slugifyTopic` slice.
const SLUG_MAX_LEN: usize = 64;

/// Reserved directory names under the planning root that are not topics.
const RESERVED_PLANNING_ENTRIES: &[&str] = &["phases", "logs", "cache"];

/// Context file name (per-topic agent output log).
pub const CONTEXT_FILE: &str = "context.md";

/// Decisions file name (per-topic design decision log).
pub const DECISIONS_FILE: &str = "decisions.md";

/// Task file name.
pub const TASK_FILE: &str = "task.md";

/// Plan file name.
pub const PLAN_FILE: &str = "plan.md";

/// Affect file name (files impacted by the topic).
pub const AFFECT_FILE: &str = "affect.md";

/// Normalize a free-form topic name into a directory-safe slug.
///
/// Mirrors `src/tools/planning-state-lib.ts:slugifyTopic` (the canonical TS impl).
/// Returns an empty string when nothing usable remains.
pub fn slugify_topic(topic: &str) -> String {
    let s = topic.trim().to_lowercase();
    // Replace any non-[a-z0-9] run with a single hyphen.
    let mut out = String::with_capacity(s.len());
    let mut in_run = false;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    // Strip leading/trailing hyphens, then slice to max length.
    let trimmed: String = out.trim_matches('-').to_string();
    trimmed.chars().take(SLUG_MAX_LEN).collect()
}

use sha2::{Digest, Sha256};

/// Normalize path deterministically for project ID generation.
/// Mirrors `src/tools/planning-state-lib.ts:normalizePathForId`.
/// Normalize path deterministically for project ID generation.
/// Mirrors `src/tools/planning-state-lib.ts:normalizePathForId`.
pub fn normalize_path_for_id(directory: &Path) -> PathBuf {
    let mut s = directory.to_string_lossy().replace('\\', "/");
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        let drive = (s.as_bytes()[0] as char).to_ascii_uppercase();
        s = format!("{}{}", drive, &s[1..]);
    }

    let path_buf = PathBuf::from(&s);
    let abs = if path_buf.is_absolute() || (s.len() >= 2 && s.as_bytes()[1] == b':') {
        path_buf
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path_buf)
    };

    let resolved = if abs.exists() {
        std::fs::canonicalize(&abs).unwrap_or(abs)
    } else {
        normalize_components(&abs)
    };

    let mut path_str = resolved.to_string_lossy().replace('\\', "/");
    if path_str.starts_with("//?/") || path_str.starts_with(r"\\?\") {
        path_str = path_str[4..].to_string();
    }

    if path_str.len() >= 2 && path_str.as_bytes()[1] == b':' {
        let drive = (path_str.as_bytes()[0] as char).to_ascii_uppercase();
        path_str = format!("{}{}", drive, &path_str[1..]);
    }

    if path_str.len() > 3 && path_str.ends_with('/') {
        path_str.pop();
    }

    PathBuf::from(path_str)
}

fn normalize_components(path: &Path) -> PathBuf {
    use std::path::Component;

    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if let Some(last) = components.last() {
                    if matches!(last, Component::Normal(_)) {
                        components.pop();
                    } else {
                        components.push(component);
                    }
                } else {
                    components.push(component);
                }
            }
            _ => components.push(component),
        }
    }
    components.into_iter().collect()
}

/// Generate a collision-safe project identifier from a repository root directory.
/// Mirrors `src/tools/planning-state-lib.ts:generateProjectId`.
pub fn generate_project_id(directory: &Path) -> String {
    let norm = normalize_path_for_id(directory);
    let path_str = norm.to_string_lossy().replace('\\', "/");
    let name = norm.file_name().and_then(|n| n.to_str()).unwrap_or("");

    let mut hasher = Sha256::new();
    hasher.update(path_str.as_bytes());
    let hash = format!("{:x}", hasher.finalize());
    format!("{}-{}", name, &hash[..8])
}

/// Global planning root: `~/.fd-plan/<project-slug>/`.
/// Legacy migration is handled separately by `migrate_legacy_planning_dir`.
pub fn planning_dir(home: &Path, project_slug: &str) -> PathBuf {
    home.join(".fd-plan").join(project_slug)
}

fn count_dir_entries(dir: &Path) -> std::io::Result<usize> {
    let mut count = 0;
    if !dir.exists() {
        return Ok(0);
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        count += 1;
        if ty.is_dir() {
            count += count_dir_entries(&entry.path())?;
        }
    }
    Ok(count)
}

/// Migrate legacy planning state from `~/.fd-plan/<legacy_name>/` to `~/.fd-plan/<project_slug>/`.
/// Returns a migration result indicating success, no-op, or failure reason.
pub fn migrate_legacy_planning_dir(
    home: &Path,
    project_slug: &str,
    legacy_name: &str,
) -> Result<MigrationResult, MigrationError> {
    let root = home.join(".fd-plan");
    let new_dir = root.join(project_slug);
    let legacy_dir = root.join(legacy_name);

    // 1. Nothing to migrate if legacy_dir does not exist
    if !legacy_dir.exists() || !legacy_dir.is_dir() {
        if new_dir.exists() && new_dir.join("STATE.md").exists() {
            return Ok(MigrationResult::AlreadyMigrated);
        }
        return Ok(MigrationResult::NoOp);
    }

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();

    // 2. If new_dir exists and is complete, and legacy_dir is present:
    // Remove the recreated legacy dir — it was already migrated and backed up
    // from the first call. If the backup path exists (same ms timestamp from a
    // fast re-run), std::fs::rename fails with "Directory not empty", so use
    // remove_dir_all instead.
    if new_dir.exists() && new_dir.join("STATE.md").exists() {
        if legacy_dir.exists() {
            let _ = std::fs::remove_dir_all(&legacy_dir);
        }
        return Ok(MigrationResult::AlreadyMigrated);
    }

    // 3. Legacy dir must have STATE.md to be valid
    if !legacy_dir.join("STATE.md").exists() {
        return Err(MigrationError::MissingState(legacy_name.to_string()));
    }

    // 4. Create sibling temporary directory
    let tmp_dir = root.join(format!("{}.tmp.{}", project_slug, now_ms));

    let perform_migration = || -> Result<usize, MigrationError> {
        std::fs::create_dir_all(&tmp_dir)
            .map_err(|e| MigrationError::CreateFailed(tmp_dir.clone(), e.to_string()))?;

        let count = copy_dir_recursive_count(&legacy_dir, &tmp_dir).map_err(|e| {
            MigrationError::CopyFailed(legacy_dir.clone(), tmp_dir.clone(), e.to_string())
        })?;

        // Validate required file in tmp_dir
        if !tmp_dir.join("STATE.md").exists() {
            return Err(MigrationError::ValidationFailed(
                tmp_dir.clone(),
                "STATE.md missing after copy".to_string(),
            ));
        }

        // Validate entry counts match
        let legacy_entries = count_dir_entries(&legacy_dir)
            .map_err(|e| MigrationError::ReadFailed(legacy_dir.clone(), e.to_string()))?;
        let tmp_entries = count_dir_entries(&tmp_dir)
            .map_err(|e| MigrationError::ReadFailed(tmp_dir.clone(), e.to_string()))?;

        if legacy_entries != tmp_entries {
            return Err(MigrationError::ValidationFailed(
                tmp_dir.clone(),
                format!(
                    "Entry count mismatch: expected {}, got {}",
                    legacy_entries, tmp_entries
                ),
            ));
        }

        // If new_dir exists but is incomplete, move it to a recovery backup first
        if new_dir.exists() {
            let recovery_dir = root.join(format!("{}.bak.incomplete.{}", project_slug, now_ms));
            std::fs::rename(&new_dir, &recovery_dir).map_err(|e| {
                MigrationError::RenameFailed(new_dir.clone(), recovery_dir, e.to_string())
            })?;
        }

        // Atomically rename completed temporary directory into place
        std::fs::rename(&tmp_dir, &new_dir).map_err(|e| {
            MigrationError::RenameFailed(tmp_dir.clone(), new_dir.clone(), e.to_string())
        })?;

        // Validate new_dir exists and is complete
        if !new_dir.join("STATE.md").exists() {
            return Err(MigrationError::ValidationFailed(
                new_dir.clone(),
                "STATE.md missing in destination".to_string(),
            ));
        }

        // Rename legacy directory to timestamped backup only AFTER destination validation
        let backup_dir = root.join(format!("{}.bak.{}", legacy_name, now_ms));
        std::fs::rename(&legacy_dir, &backup_dir).map_err(|e| {
            MigrationError::RenameFailed(legacy_dir.clone(), backup_dir, e.to_string())
        })?;

        Ok(count)
    };

    match perform_migration() {
        Ok(count) => Ok(MigrationResult::Migrated { entries: count }),
        Err(err) => {
            if tmp_dir.exists() {
                let _ = std::fs::remove_dir_all(&tmp_dir);
            }
            Err(err)
        }
    }
}

fn copy_dir_recursive_count(src: &Path, dst: &Path) -> std::io::Result<usize> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }
    let mut count = 0usize;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if ty.is_dir() {
            count += copy_dir_recursive_count(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), dest_path)?;
            count += 1;
        }
    }
    Ok(count)
}

#[derive(Debug, Clone, PartialEq)]
pub enum MigrationResult {
    NoOp,
    AlreadyMigrated,
    Migrated { entries: usize },
}

#[derive(Debug, Clone)]
pub enum MigrationError {
    MissingState(String),
    CreateFailed(PathBuf, String),
    ReadFailed(PathBuf, String),
    CopyFailed(PathBuf, PathBuf, String),
    ValidationFailed(PathBuf, String),
    RenameFailed(PathBuf, PathBuf, String),
}

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MigrationError::MissingState(name) => {
                write!(f, "Legacy directory ~/.fd-plan/{} has no STATE.md", name)
            }
            MigrationError::CreateFailed(p, msg) => {
                write!(f, "Failed to create directory {}: {}", p.display(), msg)
            }
            MigrationError::ReadFailed(p, msg) => {
                write!(f, "Failed to read directory {}: {}", p.display(), msg)
            }
            MigrationError::CopyFailed(src, dst, msg) => {
                write!(
                    f,
                    "Failed to copy {} to {}: {}",
                    src.display(),
                    dst.display(),
                    msg
                )
            }
            MigrationError::ValidationFailed(p, msg) => {
                write!(f, "Validation failed for {}: {}", p.display(), msg)
            }
            MigrationError::RenameFailed(src, dst, msg) => {
                write!(
                    f,
                    "Failed to rename {} to {}: {}",
                    src.display(),
                    dst.display(),
                    msg
                )
            }
        }
    }
}

#[allow(dead_code)]
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let dest_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), dest_path)?;
        }
    }
    Ok(())
}

/// Per-topic directory: `~/.fd-plan/<project-slug>/<topic-slug>/`.
pub fn topic_dir(home: &Path, project_slug: &str, topic: &str) -> PathBuf {
    planning_dir(home, project_slug).join(slugify_topic(topic))
}

/// Per-topic context log path: `~/.fd-plan/<project-slug>/<topic>/context.md`.
pub fn topic_context_path(home: &Path, project_slug: &str, topic: &str) -> PathBuf {
    topic_dir(home, project_slug, topic).join(CONTEXT_FILE)
}

/// Per-topic decisions path: `~/.fd-plan/<project-slug>/<topic>/decisions.md`.
pub fn topic_decisions_path(home: &Path, project_slug: &str, topic: &str) -> PathBuf {
    topic_dir(home, project_slug, topic).join(DECISIONS_FILE)
}

/// Per-topic task path: `~/.fd-plan/<project-slug>/<topic>/task.md`.
pub fn topic_task_path(home: &Path, project_slug: &str, topic: &str) -> PathBuf {
    topic_dir(home, project_slug, topic).join(TASK_FILE)
}

/// Per-topic plan path: `~/.fd-plan/<project-slug>/<topic>/plan.md`.
pub fn topic_plan_path(home: &Path, project_slug: &str, topic: &str) -> PathBuf {
    topic_dir(home, project_slug, topic).join(PLAN_FILE)
}

/// Per-topic affect path: `~/.fd-plan/<project-slug>/<topic>/affect.md`.
pub fn topic_affect_path(home: &Path, project_slug: &str, topic: &str) -> PathBuf {
    topic_dir(home, project_slug, topic).join(AFFECT_FILE)
}

/// Generate a collision-safe project slug from a directory path.
/// Uses `generate_project_id` which always hashes the canonical path.
/// The legacy heuristic (checking for hyphen + length > 9) is removed
/// because it incorrectly treated naturally hyphenated names as already hashed.
pub fn project_slug_from_directory(directory: &Path) -> String {
    generate_project_id(directory)
}

/// Reserved planning entries (not topics). Reserved for future use.
#[allow(dead_code)]
pub fn is_reserved_planning_entry(name: &str) -> bool {
    RESERVED_PLANNING_ENTRIES.contains(&name)
}

fn has_git_repository_metadata(directory: &Path) -> bool {
    let git = directory.join(".git");
    if git.is_dir() {
        return git.join("HEAD").is_file();
    }
    if git.is_file() {
        return std::fs::read_to_string(git)
            .map(|contents| contents.trim_start().starts_with("gitdir:"))
            .unwrap_or(false);
    }
    false
}

pub fn find_repository_root(current_dir: &Path) -> std::io::Result<PathBuf> {
    let current = current_dir
        .canonicalize()
        .unwrap_or_else(|_| current_dir.to_path_buf());

    // First try git rev-parse
    if let Ok(output) = std::process::Command::new("git")
        .arg("rev-parse")
        .arg("--show-toplevel")
        .current_dir(&current)
        .output()
    {
        if output.status.success() {
            if let Ok(git_root) = String::from_utf8(output.stdout) {
                let trimmed = git_root.trim();
                if !trimmed.is_empty() {
                    return Ok(PathBuf::from(trimmed));
                }
            }
        }
    }

    // Fallback: search upward for valid-looking Git metadata. Merely finding an
    // empty/stale `.git` path must not change repository identity.
    let mut search = current.clone();
    loop {
        if has_git_repository_metadata(&search) {
            return Ok(search);
        }
        if !search.pop() {
            break;
        }
    }

    // If no git root, just use current canonical dir
    Ok(current)
}

#[cfg(test)]
mod tests {

    use super::*;

    #[test]
    fn slugify_matches_ts_canonical() {
        // These cases match src/tools/planning-state-lib.ts:slugifyTopic behavior.
        assert_eq!(slugify_topic("Orchestrator Prompt"), "orchestrator-prompt");
        assert_eq!(slugify_topic("orchestrator-prompt"), "orchestrator-prompt");
        assert_eq!(slugify_topic("  Spaces  Around  "), "spaces-around");
        assert_eq!(slugify_topic("MixedCase123"), "mixedcase123");
        assert_eq!(slugify_topic("---"), "");
        assert_eq!(slugify_topic(""), "");
    }

    #[test]
    fn slugify_caps_at_max_length() {
        let long = "a".repeat(100);
        let result = slugify_topic(&long);
        assert_eq!(result.len(), SLUG_MAX_LEN);
    }

    #[test]
    fn repository_root_ignores_empty_git_directory() {
        let temp = tempfile::tempdir().unwrap();
        let nested = temp.path().join("repo").join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir(temp.path().join(".git")).unwrap();

        assert_eq!(
            find_repository_root(&nested).unwrap(),
            nested.canonicalize().unwrap()
        );
    }

    #[test]
    fn repository_root_accepts_git_directory_with_head() {
        let temp = tempfile::tempdir().unwrap();
        let nested = temp.path().join("nested");
        let git = temp.path().join(".git");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::create_dir(&git).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();

        assert_eq!(
            find_repository_root(&nested).unwrap(),
            temp.path().canonicalize().unwrap()
        );
    }

    #[test]
    fn paths_join_correctly() {
        let home = Path::new("/home/test");
        let p = topic_context_path(home, "myproj", "My Topic");
        assert_eq!(
            p.to_str().unwrap(),
            "/home/test/.fd-plan/myproj/my-topic/context.md"
        );
    }
}
