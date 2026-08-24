use fdx::reader::code::cache::AstCache;
use fdx::reader::diff::{diff_against, DiffOptions, FileStatus};
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::tempdir;

fn run_git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap_or_else(|error| panic!("failed to invoke git {args:?}: {error}"));
    assert!(
        output.status.success(),
        "git {args:?} failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn setup_git_repo(repo: &Path) {
    run_git(repo, &["init"]);
    run_git(repo, &["config", "user.email", "test@test.com"]);
    run_git(repo, &["config", "user.name", "Test"]);
    std::fs::write(
        repo.join("test.rs"),
        "pub fn original() -> i32 {\n    42\n}\n",
    )
    .unwrap();
    run_git(repo, &["add", "."]);
    run_git(repo, &["commit", "-m", "initial"]);
}

fn options(root: &Path, staged: bool, paths: Vec<PathBuf>) -> DiffOptions {
    DiffOptions {
        commit: "HEAD".to_string(),
        staged,
        paths,
        no_cache: true,
        root: root.to_path_buf(),
    }
}

#[test]
fn test_diff_modified_file() {
    let temp = tempdir().unwrap();
    let repo = temp.path();
    setup_git_repo(repo);
    std::fs::write(
        repo.join("test.rs"),
        "pub fn original() -> i32 {\n    42\n}\n\npub fn new_function() -> i32 {\n    100\n}\n",
    )
    .unwrap();

    let results = diff_against(
        &options(repo, false, vec![PathBuf::from("test.rs")]),
        &AstCache::new(),
    )
    .unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, FileStatus::Modified);
    assert_eq!(results[0].path, "test.rs");
    assert!(
        results[0]
            .symbol_changes
            .iter()
            .any(|change| change.name == "new_function"),
        "expected new_function in symbol changes"
    );
}

#[test]
fn test_diff_no_changes() {
    let temp = tempdir().unwrap();
    setup_git_repo(temp.path());
    let results = diff_against(&options(temp.path(), false, vec![]), &AstCache::new()).unwrap();
    assert!(results.is_empty());
}

#[test]
fn test_diff_not_git_repo() {
    let temp = tempdir().unwrap();
    let result = diff_against(&options(temp.path(), false, vec![]), &AstCache::new());
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("not a git repository"));
}

#[test]
fn test_diff_staged_changes() {
    let temp = tempdir().unwrap();
    let repo = temp.path();
    setup_git_repo(repo);
    std::fs::write(
        repo.join("test.rs"),
        "pub fn original() -> i32 {\n    42\n}\n\npub fn staged_fn() {}\n",
    )
    .unwrap();
    run_git(repo, &["add", "."]);

    let results = diff_against(&options(repo, true, vec![]), &AstCache::new()).unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, FileStatus::Modified);
    assert_eq!(results[0].path, "test.rs");
}
