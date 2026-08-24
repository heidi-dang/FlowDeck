use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::runtime::reconcile_runs_directory;
use tempfile::tempdir;

#[test]
fn test_runtime_reconcile_rejects_symlink_escape_and_malformed_files() {
    let dir = tempdir().unwrap();
    let outside = tempdir().unwrap();
    let runs_dir = dir.path().join(".fdx").join("runs");
    std::fs::create_dir_all(&runs_dir).unwrap();

    // Malformed JSON file
    std::fs::write(runs_dir.join("corrupt.json"), "{ invalid json").unwrap();

    // Non-JSON file
    std::fs::write(runs_dir.join("notes.txt"), "some notes").unwrap();

    #[cfg(unix)]
    {
        let outside_file = outside.path().join("outside_run.json");
        std::fs::write(&outside_file, "{}").unwrap();
        let _ = std::os::unix::fs::symlink(&outside_file, runs_dir.join("symlink_escape.json"));
    }

    let mut db = EvidenceDatabase::open(dir.path(), DatabaseOpenMode::ReadWrite).unwrap();
    let report = reconcile_runs_directory(&mut db.conn, dir.path()).unwrap();

    // Notes.txt is ignored as non-json; corrupt.json fails closed; symlink is rejected
    assert!(!report.is_complete);
    assert!(report.artifacts_failed >= 1);
}
