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

/// Normalize path deterministically for project ID generation (canonical
/// algorithm v1 — see `docs/project-identity.md` and
/// `fixtures/fdx/project-identity-v1.json`).
/// Mirrors `src/tools/planning-state-lib.ts:normalizePathForId`.
pub fn normalize_path_for_id(directory: &Path) -> PathBuf {
    let mut s = directory.to_string_lossy().replace('\\', "/");
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        let drive = (s.as_bytes()[0] as char).to_ascii_uppercase();
        s = format!("{}{}", drive, &s[1..]);
    }

    // UNC (network share) paths are canonical as given: no symlink or 8.3
    // short-name resolution is applied, matching the TypeScript side.
    let is_unc = s.starts_with("//");

    let path_buf = PathBuf::from(&s);
    let abs = if path_buf.is_absolute() || (s.len() >= 2 && s.as_bytes()[1] == b':') {
        path_buf
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path_buf)
    };

    let resolved = if !is_unc && abs.exists() {
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

/// Lexically normalize `.`/`..`/repeated-separator components without touching
/// the filesystem. Mirrors `path.resolve` semantics from
/// `src/tools/planning-state-lib.ts:normalizePathForId` (canonical algorithm
/// v1, see `docs/project-identity.md`): `..` that would climb above the root
/// is dropped, so `/..` normalizes to `/`.
fn normalize_components(path: &Path) -> PathBuf {
    use std::path::Component;

    let mut components = Vec::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(components.last(), Some(Component::Normal(_))) {
                    components.pop();
                }
                // Otherwise drop the ParentDir: climbing above the root (or
                // above a drive prefix / UNC root) is a no-op, matching
                // path.resolve on every platform.
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

/// Number of retry attempts for transient Windows sharing violations.
const RENAME_SHARING_RETRY_ATTEMPTS: usize = 5;

/// Retry a fallible operation when (and only when) `classify` reports a
/// transient Windows sharing violation. Antivirus scanners and indexers can
/// transiently hold a directory open for a few hundred milliseconds; every
/// other error — including `ERROR_ACCESS_DENIED` (5) — is returned
/// immediately without retry. `backoff_ms` is the initial delay; each retry
/// doubles it (deterministic, bounded). On success returns the number of
/// attempts used.
fn retry_sharing_violation<T>(
    attempts: usize,
    backoff_ms: u64,
    classify: impl Fn(&std::io::Error) -> bool,
    mut f: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<(T, usize)> {
    let attempts = attempts.max(1);
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 1..=attempts {
        match f() {
            Ok(value) => return Ok((value, attempt)),
            Err(e) => {
                if !classify(&e) {
                    return Err(e);
                }
                last_err = Some(e);
                if attempt < attempts {
                    std::thread::sleep(std::time::Duration::from_millis(
                        backoff_ms << (attempt - 1),
                    ));
                }
            }
        }
    }
    Err(last_err.map_or_else(
        || std::io::Error::other("operation failed"),
        |e| std::io::Error::new(e.kind(), format!("{e} (after {attempts} retry attempts)")),
    ))
}

/// True only on Windows for `ERROR_SHARING_VIOLATION` (os error 32).
fn is_windows_sharing_violation(e: &std::io::Error) -> bool {
    cfg!(windows) && e.raw_os_error() == Some(32)
}

/// Rename `src` to `dst`, retrying bounded times on Windows sharing
/// violations only. On POSIX this is a plain rename. The returned `usize` is
/// the number of attempts used on success.
fn rename_with_sharing_retry(src: &Path, dst: &Path) -> std::io::Result<usize> {
    retry_sharing_violation(
        RENAME_SHARING_RETRY_ATTEMPTS,
        25,
        is_windows_sharing_violation,
        || std::fs::rename(src, dst),
    )
    .map(|((), attempts)| attempts)
}

/// On Windows a process cannot rename (or delete) a directory that is its own
/// current working directory — the OS refuses with `ERROR_SHARING_VIOLATION`
/// (os error 32). The fdx `context`/`decisions` commands run with their cwd set
/// to the legacy planning directory, so before any rename of that directory the
/// process cwd must be moved elsewhere. On POSIX this is a no-op (renaming your
/// own cwd is allowed), but performing it everywhere keeps behavior identical
/// across platforms.
fn release_cwd_pin(root: &Path, legacy_dir: &Path) {
    let Ok(cwd) = std::env::current_dir() else {
        return;
    };
    if cwd.starts_with(legacy_dir) {
        let _ = std::env::set_current_dir(root);
    }
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

    // The caller may have started this process with cwd inside the legacy
    // directory (the fdx context/decisions commands do exactly that). Windows
    // will refuse to rename that directory while it is our own cwd, so release
    // the pin before any rename. Also makes the later renames deterministic on
    // every platform.
    release_cwd_pin(&root, &legacy_dir);

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

    // Remove the recreated legacy dir — it was already migrated and backed up
    // from the first call. Use a unique backup directory to avoid ENOTEMPTY
    // when a plugin loop rapidly recreates the legacy path within the same ms.
    if new_dir.exists() && new_dir.join("STATE.md").exists() {
        let backup_dir = get_unique_backup_dir(&root, legacy_name, now_ms);
        rename_with_sharing_retry(&legacy_dir, &backup_dir).map_err(|e| {
            MigrationError::RenameFailed(legacy_dir.clone(), backup_dir, e.to_string())
        })?;
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

        // Durability: flush copied files (done above) and the tmp directory
        // entry so the completed destination survives a crash before activation.
        sync_directory(&tmp_dir).map_err(|e| {
            MigrationError::ValidationFailed(
                tmp_dir.clone(),
                format!("failed to sync temporary destination: {e}"),
            )
        })?;

        // If new_dir exists but is incomplete, move it to a recovery backup first
        if new_dir.exists() {
            let recovery_dir =
                get_unique_backup_dir(&root, &format!("{}.incomplete", project_slug), now_ms);
            rename_with_sharing_retry(&new_dir, &recovery_dir).map_err(|e| {
                MigrationError::RenameFailed(new_dir.clone(), recovery_dir, e.to_string())
            })?;
        }

        // Atomically rename completed temporary directory into place
        rename_with_sharing_retry(&tmp_dir, &new_dir).map_err(|e| {
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
        let backup_dir = get_unique_backup_dir(&root, legacy_name, now_ms);
        rename_with_sharing_retry(&legacy_dir, &backup_dir).map_err(|e| {
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

fn get_unique_backup_dir(root: &Path, prefix: &str, now_ms: u128) -> PathBuf {
    let base = root.join(format!("{}.bak.{}", prefix, now_ms));
    if !base.exists() {
        return base;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    let mut candidate = root.join(format!("{}.bak.{}.{}", prefix, now_ms, nanos));
    let mut count = 1;
    while candidate.exists() {
        candidate = root.join(format!("{}.bak.{}.{}_{}", prefix, now_ms, nanos, count));
        count += 1;
    }
    candidate
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
            let mut fin = std::fs::File::open(entry.path())?;
            let mut fout = std::fs::File::create(&dest_path)?;
            std::io::copy(&mut fin, &mut fout)?;
            // fsync each copied file so the temporary destination is durable
            // before it is activated by rename.
            fout.sync_all()?;
            count += 1;
        }
    }
    Ok(count)
}

/// fsync a directory entry so a completed copy survives a crash. Windows does
/// not allow opening directories with `File::open`, so this is a no-op there
/// (Windows flushes metadata through the per-file `sync_all` above).
#[cfg(unix)]
fn sync_directory(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_dir: &Path) -> std::io::Result<()> {
    Ok(())
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
    fn paths_join_correctly() {
        let home = Path::new("/home/test");
        let p = topic_context_path(home, "myproj", "My Topic");
        assert_eq!(
            p.to_str().unwrap(),
            "/home/test/.fd-plan/myproj/my-topic/context.md"
        );
    }

    // ── Legacy migration ────────────────────────────────────────────────

    use std::sync::atomic::{AtomicU64, Ordering};

    static MIG_TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_tmp(name: &str) -> PathBuf {
        let n = MIG_TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        std::env::temp_dir().join(format!("fdx-mig-unit-{name}-{pid}-{n}"))
    }

    fn write(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn seed_legacy(root: &Path, name: &str) -> PathBuf {
        let legacy = root.join(".fd-plan").join(name);
        write(&legacy.join("STATE.md"), "# State\n");
        write(&legacy.join("topic-1").join("context.md"), "# Context\n");
        write(&legacy.join("topic-2").join("plan.md"), "# Plan\n");
        legacy
    }

    fn dir_entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn migrate_moves_nested_legacy_to_slug_with_single_backup() {
        let home = unique_tmp("ok");
        let legacy = seed_legacy(&home, "my-app");
        let slug = "my-app-12345678";

        let result = migrate_legacy_planning_dir(&home, slug, "my-app").unwrap();
        assert_eq!(result, MigrationResult::Migrated { entries: 3 });

        let new_dir = home.join(".fd-plan").join(slug);
        assert!(new_dir.join("STATE.md").exists());
        assert!(new_dir.join("topic-1").join("context.md").exists());
        assert!(!legacy.exists(), "legacy dir must be renamed away");

        let plan_names = dir_entries(&home.join(".fd-plan"));
        let backups: Vec<&String> = plan_names
            .iter()
            .filter(|n| n.starts_with("my-app.bak."))
            .collect();
        assert_eq!(backups.len(), 1, "exactly one backup: {plan_names:?}");
        assert!(home
            .join(".fd-plan")
            .join(backups[0])
            .join("STATE.md")
            .exists());
        let tmp_left: Vec<&String> = plan_names.iter().filter(|n| n.contains(".tmp.")).collect();
        assert!(tmp_left.is_empty(), "no tmp dirs left: {plan_names:?}");
    }

    #[test]
    fn migrate_missing_state_returns_error_and_leaves_no_partial_output() {
        let home = unique_tmp("missing-state");
        let root = home.join(".fd-plan");
        std::fs::create_dir_all(root.join("my-app")).unwrap();
        std::fs::write(root.join("my-app").join("junk.txt"), "no state").unwrap();

        let err = migrate_legacy_planning_dir(&home, "slug-00000000", "my-app").unwrap_err();
        assert!(matches!(err, MigrationError::MissingState(_)), "{err}");

        let plan_names = dir_entries(&root);
        let tmp_left: Vec<&String> = plan_names.iter().filter(|n| n.contains(".tmp.")).collect();
        assert!(tmp_left.is_empty(), "no partial output: {plan_names:?}");
    }

    #[test]
    fn migrate_is_idempotent_on_second_run() {
        let home = unique_tmp("idempotent");
        let legacy = seed_legacy(&home, "my-app");
        let slug = "my-app-12345678";

        migrate_legacy_planning_dir(&home, slug, "my-app").unwrap();

        // Simulate a plugin loop recreating the legacy dir.
        std::fs::create_dir_all(&legacy).unwrap();
        write(&legacy.join("STATE.md"), "# State\n");

        let result = migrate_legacy_planning_dir(&home, slug, "my-app").unwrap();
        assert_eq!(result, MigrationResult::AlreadyMigrated);

        let plan_names = dir_entries(&home.join(".fd-plan"));
        let backups: Vec<&String> = plan_names
            .iter()
            .filter(|n| n.starts_with("my-app.bak."))
            .collect();
        assert_eq!(
            backups.len(),
            2,
            "first run + recreated legacy: {plan_names:?}"
        );
        assert!(!legacy.exists(), "recreated legacy must be backed up too");
    }

    #[test]
    fn migrate_preserves_incomplete_destination_as_recovery_backup() {
        let home = unique_tmp("incomplete-dest");
        seed_legacy(&home, "my-app");
        let slug = "my-app-12345678";

        // Simulate a previous interrupted run: destination exists but incomplete.
        write(&home.join(".fd-plan").join(slug).join("partial.txt"), "x");

        let result = migrate_legacy_planning_dir(&home, slug, "my-app").unwrap();
        assert_eq!(result, MigrationResult::Migrated { entries: 3 });

        let plan_names = dir_entries(&home.join(".fd-plan"));
        let recovery: Vec<&String> = plan_names
            .iter()
            .filter(|n| n.contains(".incomplete.bak."))
            .collect();
        assert_eq!(
            recovery.len(),
            1,
            "incomplete destination preserved: {plan_names:?}"
        );
        assert!(home.join(".fd-plan").join(slug).join("STATE.md").exists());
    }

    #[test]
    fn migrate_handles_unicode_spaces_and_shell_metacharacters() {
        let home = unique_tmp("special-chars");
        let legacy_name = "my app & repo (über) [v2]";
        seed_legacy(&home, legacy_name);
        let slug = "slug-00000000";

        migrate_legacy_planning_dir(&home, slug, legacy_name).unwrap();

        let plan_names = dir_entries(&home.join(".fd-plan"));
        let backups: Vec<&String> = plan_names
            .iter()
            .filter(|n| n.starts_with("my app & repo (über) [v2].bak."))
            .collect();
        assert_eq!(backups.len(), 1, "{plan_names:?}");
    }

    #[test]
    fn migrate_after_interruption_at_destination_activation_is_recoverable() {
        // Interruption point: destination activated (complete) but legacy
        // backup rename never happened. Next run must take the AlreadyMigrated
        // path and back the legacy dir up without duplicating the destination.
        let home = unique_tmp("interrupted");
        let legacy = seed_legacy(&home, "my-app");
        let slug = "my-app-12345678";

        write(
            &home.join(".fd-plan").join(slug).join("STATE.md"),
            "# State\n",
        );
        write(
            &home
                .join(".fd-plan")
                .join(slug)
                .join("topic-1")
                .join("context.md"),
            "# C\n",
        );

        let result = migrate_legacy_planning_dir(&home, slug, "my-app").unwrap();
        assert_eq!(result, MigrationResult::AlreadyMigrated);
        assert!(!legacy.exists());

        let plan_names = dir_entries(&home.join(".fd-plan"));
        let backups: Vec<&String> = plan_names
            .iter()
            .filter(|n| n.starts_with("my-app.bak."))
            .collect();
        assert_eq!(backups.len(), 1, "{plan_names:?}");
    }

    // ── Sharing-violation retry ─────────────────────────────────────────

    #[test]
    fn retry_succeeds_after_transient_sharing_violations() {
        let mut calls = 0;
        let (value, attempts) = retry_sharing_violation(
            5,
            1,
            |_| true,
            || -> std::io::Result<&str> {
                calls += 1;
                if calls < 3 {
                    Err(std::io::Error::from_raw_os_error(32))
                } else {
                    Ok("done")
                }
            },
        )
        .unwrap();
        assert_eq!(value, "done");
        assert_eq!(attempts, 3);
        assert_eq!(calls, 3);
    }

    #[test]
    fn retry_does_not_retry_permission_denial() {
        let mut calls = 0;
        // Classifier as it would behave on Windows: retry only os error 32.
        let err = retry_sharing_violation(
            5,
            1,
            |e| e.raw_os_error() == Some(32),
            || {
                calls += 1;
                Err::<u8, _>(std::io::Error::from_raw_os_error(5)) // ERROR_ACCESS_DENIED
            },
        )
        .unwrap_err();
        assert_eq!(calls, 1, "permission denial must not be retried");
        assert_eq!(err.raw_os_error(), Some(5));
    }

    #[test]
    fn retry_gives_up_after_bounded_attempts_with_diagnostics() {
        let mut calls = 0;
        let err = retry_sharing_violation(
            4,
            1,
            |_| true,
            || {
                calls += 1;
                Err::<u8, _>(std::io::Error::from_raw_os_error(32))
            },
        )
        .unwrap_err();
        assert_eq!(calls, 4, "bounded retry attempts");
        assert!(err.to_string().contains("retry attempts"), "{err}");
    }

    #[test]
    fn retry_passthrough_when_classifier_rejects() {
        let mut calls = 0;
        let err = retry_sharing_violation(
            5,
            1,
            |e| e.raw_os_error() == Some(32),
            || {
                calls += 1;
                Err::<u8, _>(std::io::Error::from_raw_os_error(13)) // EACCES on POSIX
            },
        )
        .unwrap_err();
        assert_eq!(calls, 1, "non-sharing-violation must not be retried");
        assert_eq!(err.raw_os_error(), Some(13));
    }

    #[test]
    fn is_windows_sharing_violation_classifier() {
        let sharing = std::io::Error::from_raw_os_error(32);
        let _denied = std::io::Error::from_raw_os_error(5);
        // cfg!(windows) is evaluated per-target at compile time.
        #[cfg(windows)]
        {
            assert!(is_windows_sharing_violation(&sharing));
            assert!(!is_windows_sharing_violation(&denied));
        }
        #[cfg(not(windows))]
        {
            assert!(
                !is_windows_sharing_violation(&sharing),
                "POSIX must not retry"
            );
        }
    }
}
