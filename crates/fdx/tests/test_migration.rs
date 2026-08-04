use fdx::paths::{migrate_legacy_planning_dir, MigrationResult};
use std::fs;
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
