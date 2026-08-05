//! Integration tests for legacy planning-directory migration.
//!
//! Exercises `migrate_legacy_planning_dir` through the public crate API.
//! The Windows regression guarded here: `fdx context`/`fdx decisions` start
//! with their cwd inside the legacy planning directory, and Windows refuses to
//! rename a directory that is the calling process's own current working
//! directory (`ERROR_SHARING_VIOLATION`, os error 32). Migration must release
//! the cwd pin before renaming the legacy directory.

use fdx::paths::{migrate_legacy_planning_dir, MigrationResult};
use std::fs;
use std::path::PathBuf;
use tempfile::tempdir;

#[test]
fn test_successful_migration_with_nested_directories() {
    let tmp = tempdir().unwrap();
    let home = tmp.path();
    let root = home.join(".fd-plan");
    let legacy = root.join("my-legacy-proj");
    let nested = legacy.join("topic-a");
    fs::create_dir_all(&nested).unwrap();
    fs::write(legacy.join("STATE.md"), "state content").unwrap();
    fs::write(nested.join("context.md"), "context content").unwrap();

    let project_slug = "my-legacy-proj-12345678";
    let res = migrate_legacy_planning_dir(home, project_slug, "my-legacy-proj");
    assert!(res.is_ok(), "Migration should succeed");
    let res = res.unwrap();
    assert!(matches!(res, MigrationResult::Migrated { entries: _ }));

    let new_dir = root.join(project_slug);
    assert!(new_dir.exists(), "New dir must exist");
    assert!(
        new_dir.join("STATE.md").exists(),
        "STATE.md must exist in new dir"
    );
    assert!(
        new_dir.join("topic-a").join("context.md").exists(),
        "Nested context.md must exist"
    );

    // Verify backup was created
    let backups: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("my-legacy-proj.bak.")
        })
        .collect();
    assert_eq!(
        backups.len(),
        1,
        "Exactly one backup directory should be created"
    );
}

#[test]
fn test_missing_state_file_returns_error() {
    let tmp = tempdir().unwrap();
    let home = tmp.path();
    let root = home.join(".fd-plan");
    let legacy = root.join("invalid-proj");
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join("other.txt"), "no state").unwrap();

    let project_slug = "invalid-proj-12345678";
    let res = migrate_legacy_planning_dir(home, project_slug, "invalid-proj");
    assert!(res.is_err(), "Missing STATE.md should return error");

    let new_dir = root.join(project_slug);
    assert!(
        !new_dir.exists(),
        "No partial destination should exist after failure"
    );
}

#[test]
fn test_existing_incomplete_destination_recovery() {
    let tmp = tempdir().unwrap();
    let home = tmp.path();
    let root = home.join(".fd-plan");
    let legacy = root.join("inc-proj");
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join("STATE.md"), "state content").unwrap();

    let project_slug = "inc-proj-12345678";
    let new_dir = root.join(project_slug);
    fs::create_dir_all(&new_dir).unwrap();
    fs::write(new_dir.join("partial.tmp"), "incomplete").unwrap(); // Missing STATE.md

    let res = migrate_legacy_planning_dir(home, project_slug, "inc-proj");
    assert!(
        res.is_ok(),
        "Migration should recover from incomplete destination"
    );

    assert!(
        new_dir.join("STATE.md").exists(),
        "Destination should now be complete"
    );

    // Verify incomplete backup was created
    let inc_backups: Vec<_> = fs::read_dir(&root)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().contains(".incomplete.bak."))
        .collect();
    assert_eq!(
        inc_backups.len(),
        1,
        "Incomplete destination should be moved to recovery backup"
    );
}

#[test]
fn test_idempotent_second_execution() {
    let tmp = tempdir().unwrap();
    let home = tmp.path();
    let root = home.join(".fd-plan");
    let legacy = root.join("idem-proj");
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join("STATE.md"), "state").unwrap();

    let project_slug = "idem-proj-12345678";
    let res1 = migrate_legacy_planning_dir(home, project_slug, "idem-proj").unwrap();
    assert!(matches!(res1, MigrationResult::Migrated { .. }));

    // Re-create legacy dir to simulate interrupted or duplicate call
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join("STATE.md"), "state").unwrap();

    let res2 = migrate_legacy_planning_dir(home, project_slug, "idem-proj").unwrap();
    assert_eq!(res2, MigrationResult::AlreadyMigrated);
}

fn seed_legacy(home: &std::path::Path, name: &str) -> PathBuf {
    let legacy = home.join(".fd-plan").join(name);
    fs::create_dir_all(legacy.join("topic-1")).unwrap();
    fs::write(legacy.join("STATE.md"), "# State\n").unwrap();
    fs::write(legacy.join("topic-1").join("context.md"), "# Context\n").unwrap();
    legacy
}

/// Regression: migrating while the process cwd is *inside* the legacy
/// directory must succeed. On Windows this fails with os error 32 unless the
/// implementation releases the cwd pin before renaming the legacy dir.
#[test]
fn migration_succeeds_when_cwd_is_inside_legacy_directory() {
    let tmp = tempdir().unwrap();
    let home = tmp.path();
    let legacy = seed_legacy(home, "my-app");
    let slug = "my-app-12345678";

    let original_cwd = std::env::current_dir().expect("cwd");
    let _guard = RestoreCwd(original_cwd);

    std::env::set_current_dir(&legacy).expect("chdir into legacy dir");

    let result = migrate_legacy_planning_dir(home, slug, "my-app").expect("migration must succeed");
    assert!(matches!(result, MigrationResult::Migrated { entries: 2 }));

    // The destination is complete and the legacy dir was renamed to a backup.
    assert!(home.join(".fd-plan").join(slug).join("STATE.md").exists());
    assert!(!legacy.exists(), "legacy dir must have been renamed away");

    let backups: Vec<String> = fs::read_dir(home.join(".fd-plan"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("my-app.bak."))
        .collect();
    assert_eq!(backups.len(), 1, "exactly one backup dir");
}

/// A second migration while cwd is inside the *recreated* legacy dir also
/// succeeds (the AlreadyMigrated fast path must release the pin too).
#[test]
fn recreated_legacy_with_cwd_inside_still_migrates() {
    let tmp = tempdir().unwrap();
    let home = tmp.path();
    let legacy = seed_legacy(home, "my-app");
    let slug = "my-app-12345678";

    migrate_legacy_planning_dir(home, slug, "my-app").unwrap();

    // Plugin loop recreated the legacy dir.
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join("STATE.md"), "# State\n").unwrap();

    let original_cwd = std::env::current_dir().expect("cwd");
    let _guard = RestoreCwd(original_cwd);
    std::env::set_current_dir(&legacy).expect("chdir into recreated legacy dir");

    let result =
        migrate_legacy_planning_dir(home, slug, "my-app").expect("recreated legacy migration");
    assert_eq!(result, MigrationResult::AlreadyMigrated);
    assert!(!legacy.exists());
}

struct RestoreCwd(PathBuf);

impl Drop for RestoreCwd {
    fn drop(&mut self) {
        let _ = std::env::set_current_dir(&self.0);
    }
}
