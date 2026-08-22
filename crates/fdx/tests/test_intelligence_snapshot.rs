use fdx::intelligence::snapshot::get_repository_snapshot;
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::tempdir;

fn git(repo: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}

fn git_silent(repo: &Path, args: &[&str]) {
    let _ = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap();
}

fn init_repo(repo: &Path) {
    git(repo, &["init"]);
    git(repo, &["config", "user.name", "test"]);
    git(repo, &["config", "user.email", "t@t.test"]);
}

#[test]
fn test_snapshot_rename_source_path_distinguishes() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    init_repo(repo);

    fs::write(repo.join("a.ts"), "same content").unwrap();
    fs::write(repo.join("c.ts"), "same content").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "init"]);

    // Rename a.ts -> b.ts
    git(repo, &["mv", "a.ts", "b.ts"]);
    let snap1 = get_repository_snapshot(repo).unwrap();

    // Reset and rename c.ts -> b.ts (same destination content/status)
    git_silent(repo, &["reset", "--hard", "HEAD"]);
    git(repo, &["mv", "c.ts", "b.ts"]);
    let snap2 = get_repository_snapshot(repo).unwrap();

    // Destination path and content are identical; only the rename source differs.
    assert_ne!(
        snap1.dirty_fingerprint, snap2.dirty_fingerprint,
        "rename source path must be part of the snapshot identity"
    );
}

#[test]
fn test_snapshot_modified_tracked_content_changes_fingerprint() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    init_repo(repo);
    fs::write(repo.join("a.ts"), "content one").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "init"]);

    // Start clean (no dirty files)
    let clean = get_repository_snapshot(repo).unwrap();

    fs::write(repo.join("a.ts"), "content two").unwrap();
    let dirty1 = get_repository_snapshot(repo).unwrap();

    // Same path/status, different content -> must change
    fs::write(repo.join("a.ts"), "content three").unwrap();
    let dirty2 = get_repository_snapshot(repo).unwrap();

    assert_ne!(clean.dirty_fingerprint, dirty1.dirty_fingerprint);
    assert_ne!(dirty1.dirty_fingerprint, dirty2.dirty_fingerprint);
}

#[test]
fn test_snapshot_untracked_content_changes_fingerprint() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    init_repo(repo);
    fs::write(repo.join("seed.ts"), "seed").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "init"]);

    fs::write(repo.join("untracked.ts"), "version one").unwrap();
    let snap1 = get_repository_snapshot(repo).unwrap();

    // Same untracked path, different content
    fs::write(repo.join("untracked.ts"), "version two").unwrap();
    let snap2 = get_repository_snapshot(repo).unwrap();

    assert_ne!(snap1.dirty_fingerprint, snap2.dirty_fingerprint);
}
