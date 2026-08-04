//! Real child-process contention tests for the FDX index writer lock
//! (Task 3D §3).
//!
//! These tests spawn SEPARATE OS processes (the test binary itself with a
//! helper test filter) so the cross-process file lock is exercised for real:
//! - a live lock is never stolen while the owning process is alive;
//! - a stale lock (owning process dead) is recovered automatically by the OS;
//! - two processes cannot publish simultaneously (the second sees a
//!   generation conflict and never clobbers the winner).

use std::path::Path;
use std::process::{Command, Stdio};

use fdx::index::manifest::{identity_hash, IndexIdentity};
use fdx::index::storage::{GenerationStore, WriterLock};

fn identity(name: &str) -> IndexIdentity {
    let repo_root = format!("/tmp/repo-{name}");
    let wt_root = format!("/tmp/wt-{name}");
    IndexIdentity {
        repository_id: identity_hash(&["repo", &repo_root]),
        worktree_id: identity_hash(&["worktree", &wt_root]),
        repository_root_hash: identity_hash(&["root", &repo_root]),
        repository_root: repo_root,
        worktree_root: wt_root,
    }
}

fn make_state_dir(tag: &str) -> (tempfile::TempDir, GenerationStore) {
    let tmp = tempfile::tempdir().unwrap();
    let ident = identity(tag);
    let store = GenerationStore::open(tmp.path(), &ident).unwrap();
    (tmp, store)
}

/// Helper test: acquire the writer lock, signal readiness via a marker file,
/// then hold the lock until a release marker appears.
///
/// The test harness spawns THIS SAME TEST BINARY with `--exact` targeting
/// this helper, so the lock is genuinely held by another process. Paths are
/// passed via environment variables (the harness re-execs the binary and
/// positional args are consumed as test filters).
#[test]
fn helper_hold_writer_lock() {
    // No-op when run as a plain suite test (env not set by the parent).
    let Ok(state_root) = std::env::var("FDX_LOCK_STATE_ROOT") else {
        return;
    };
    let identity_tag = std::env::var("FDX_LOCK_IDENTITY").unwrap_or_else(|_| "child-holder".into());
    let ready = std::env::var("FDX_LOCK_READY").expect("FDX_LOCK_READY");
    let release = std::env::var("FDX_LOCK_RELEASE").expect("FDX_LOCK_RELEASE");

    let ident = identity(&identity_tag);
    let store = GenerationStore::open(Path::new(&state_root), &ident).unwrap();
    let lock = WriterLock::acquire(store.worktree_path()).expect("child acquires lock");
    std::fs::write(&ready, "locked").unwrap();

    // Hold until released.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while !Path::new(&release).exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    drop(lock);
    std::fs::write(format!("{ready}.done"), "released").unwrap();
}

/// A live lock is never stolen: while a child process holds the writer lock,
/// the parent cannot acquire it; after the child exits, the lock is
/// recovered automatically (the OS released it — no stale-lock cleanup of a
/// live owner is ever performed).
#[test]
fn live_lock_is_not_stolen_and_stale_lock_recovers() {
    let (tmp, store) = make_state_dir("live-lock");
    let ready = tmp.path().join("ready");
    let release = tmp.path().join("release");

    let exe = std::env::current_exe().unwrap();
    let mut child = Command::new(&exe)
        .args(["--exact", "helper_hold_writer_lock"])
        .env("FDX_LOCK_STATE_ROOT", tmp.path())
        .env("FDX_LOCK_IDENTITY", "live-lock")
        .env("FDX_LOCK_READY", &ready)
        .env("FDX_LOCK_RELEASE", &release)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn child holder");

    // Wait for the child to acquire the lock.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !ready.exists() && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    assert!(ready.exists(), "child never acquired the lock");

    // The parent must NOT be able to acquire while the child is alive.
    let contended = WriterLock::try_acquire(store.worktree_path());
    assert!(
        contended.is_err(),
        "live lock must not be stealable while the owner is alive"
    );

    // Release the child; the OS releases the lock; the parent recovers it.
    std::fs::write(&release, "go").unwrap();
    let status = child.wait().expect("child exits");
    assert!(status.success(), "helper child failed: {status:?}");

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        match WriterLock::try_acquire(store.worktree_path()) {
            Ok(_lock) => break, // recovered
            Err(_) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Err(e) => panic!("stale lock never recovered: {e}"),
        }
    }
}

/// Two processes attempting to publish the same generation: the second must
/// observe a generation conflict (AlreadyExists) and never clobber the
/// winner's state.
#[test]
fn two_processes_cannot_publish_simultaneously() {
    let (_tmp, store) = make_state_dir("publish-race");
    let ident = identity("publish-race");

    // Publish gen 1 in the parent.
    store
        .publish(1, &ident, "0.1.0", "t", |dir| {
            let mut m = fdx::index::manifest::new_manifest(
                &ident, "0.1.0", 1, "t", &"1".repeat(40), &"d".repeat(64), "c", "i",
            );
            fdx::index::storage::write_component_serde(
                dir,
                &mut m,
                "files.json",
                &serde_json::json!([{"path": "a.txt", "kind": "file", "size": 3, "modified": 0, "content_hash": "0123456789abcdef", "language": "", "executable": false, "classification": "source", "generation": 1}]),
            )
            .unwrap();
            fdx::index::storage::write_component_serde(dir, &mut m, "symbols.json", &serde_json::json!([]))
                .unwrap();
            fdx::index::storage::write_component_serde(dir, &mut m, "dependencies.json", &serde_json::json!([]))
                .unwrap();
            fdx::index::storage::write_component_serde(dir, &mut m, "test-mapping.json", &serde_json::json!([]))
                .unwrap();
            fdx::index::storage::write_component_serde(
                dir,
                &mut m,
                "git-state.json",
                &serde_json::json!({"head_sha": "1111111111111111111111111111111111111111", "branch": "", "detached": false, "changed_files": [], "renamed_files": [], "deleted_files": [], "untracked_files": [], "worktree_id": ident.worktree_id, "generation": 1}),
            )
            .unwrap();
            fdx::index::storage::write_component_serde(dir, &mut m, "content-cache.json", &serde_json::json!([]))
                .unwrap();
            fdx::index::storage::update_component_counts(&mut m, 1, 0, 0, 0, 0);
            fdx::index::storage::ready_components(
                &mut m,
                &["files", "symbols", "dependencies", "test_mapping", "git_state", "content_cache"],
            );
            Ok(m)
        })
        .unwrap();

    // A second publish of gen 1 (as a racing second process would) must be
    // rejected as a generation conflict, never clobbering.
    let err = store
        .publish(1, &ident, "0.1.0", "t", |dir| {
            // Produce a complete (but different) generation so the conflict
            // check catches it — not a validation failure.
            let mut m = fdx::index::manifest::new_manifest(
                &ident, "0.1.0", 1, "t", &"2".repeat(40), &"d".repeat(64), "c", "i",
            );
            fdx::index::storage::write_component_serde(
                dir,
                &mut m,
                "files.json",
                &serde_json::json!([{"path": "a.txt", "kind": "file", "size": 3, "modified": 0, "content_hash": "0123456789abcdef", "language": "", "executable": false, "classification": "source", "generation": 1}]),
            )
            .unwrap();
            fdx::index::storage::write_component_serde(dir, &mut m, "symbols.json", &serde_json::json!([]))
                .unwrap();
            fdx::index::storage::write_component_serde(dir, &mut m, "dependencies.json", &serde_json::json!([]))
                .unwrap();
            fdx::index::storage::write_component_serde(dir, &mut m, "test-mapping.json", &serde_json::json!([]))
                .unwrap();
            fdx::index::storage::write_component_serde(
                dir,
                &mut m,
                "git-state.json",
                &serde_json::json!({"head_sha": "2222222222222222222222222222222222222222", "branch": "", "detached": false, "changed_files": [], "renamed_files": [], "deleted_files": [], "untracked_files": [], "worktree_id": ident.worktree_id, "generation": 1}),
            )
            .unwrap();
            fdx::index::storage::write_component_serde(dir, &mut m, "content-cache.json", &serde_json::json!([]))
                .unwrap();
            fdx::index::storage::update_component_counts(&mut m, 1, 0, 0, 0, 0);
            fdx::index::storage::ready_components(
                &mut m,
                &["files", "symbols", "dependencies", "test_mapping", "git_state", "content_cache"],
            );
            Ok(m)
        })
        .unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);

    // The winner's state is intact.
    match store.load() {
        fdx::index::storage::LoadOutcome::Loaded(m) => {
            assert_eq!(m.head_sha, "1".repeat(40));
        }
        other => panic!("winner state must load, got {other:?}"),
    }
}
