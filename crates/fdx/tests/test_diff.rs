use fdx::reader::code::cache::AstCache;
use fdx::reader::diff::{diff_against, DiffOptions, FileStatus};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use tempfile::TempDir;

fn git(root: &Path, args: &[&str]) -> Output {
    let output = Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .expect("git command must start");
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn setup_git_repo() -> TempDir {
    let temp_dir = TempDir::new().expect("temporary git repository");
    let root = temp_dir.path();

    git(root, &["init", "-q"]);
    git(root, &["config", "user.email", "test@test.com"]);
    git(root, &["config", "user.name", "Test"]);

    std::fs::write(
        root.join("test.rs"),
        r#"pub fn original() -> i32 {
    42
}
"#,
    )
    .unwrap();
    git(root, &["add", "."]);
    git(root, &["commit", "-m", "initial"]);

    temp_dir
}

fn options(root: &Path, staged: bool, paths: Vec<&str>) -> DiffOptions {
    DiffOptions {
        commit: "HEAD".to_string(),
        staged,
        paths: paths.into_iter().map(PathBuf::from).collect(),
        no_cache: true,
        root: root.to_path_buf(),
    }
}

fn assert_git_diff_is_coloured(root: &Path, staged: bool, paths: &[&str]) {
    let mut command = Command::new("git");
    command.arg("diff").arg("--unified=3").current_dir(root);
    if staged {
        command.arg("--cached");
    } else {
        command.arg("HEAD");
    }
    command.arg("--").args(paths);
    let output = command.output().expect("plain git diff must start");
    assert!(output.status.success());
    assert!(
        output.stdout.contains(&0x1b),
        "fixture must prove that ordinary git diff is ANSI-coloured before FDX normalizes its parsed command"
    );
}

#[test]
fn test_diff_modified_file() {
    let repo = setup_git_repo();
    let root = repo.path();
    std::fs::write(
        root.join("test.rs"),
        r#"pub fn original() -> i32 {
    42
}

pub fn new_function() -> i32 {
    100
}
"#,
    )
    .unwrap();

    let cache = AstCache::new();
    let results = diff_against(&options(root, false, vec!["test.rs"]), &cache).unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, FileStatus::Modified);
    assert_eq!(results[0].path, "test.rs");
    assert!(
        results[0]
            .symbol_changes
            .iter()
            .any(|change| change.name == "new_function"),
        "Expected new_function in symbol changes"
    );
}

#[test]
fn test_diff_no_changes() {
    let repo = setup_git_repo();
    let cache = AstCache::new();
    let results = diff_against(&options(repo.path(), false, vec![]), &cache).unwrap();
    assert!(results.is_empty());
}

#[test]
fn test_diff_not_git_repo() {
    let temp_dir = TempDir::new().expect("temporary non-git directory");
    let cache = AstCache::new();
    let result = diff_against(&options(temp_dir.path(), false, vec![]), &cache);
    assert!(result.is_err());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("not a git repository"));
}

#[test]
fn test_diff_staged_changes() {
    let repo = setup_git_repo();
    let root = repo.path();
    std::fs::write(
        root.join("test.rs"),
        r#"pub fn original() -> i32 {
    42
}

pub fn staged_fn() {}
"#,
    )
    .unwrap();
    git(root, &["add", "test.rs"]);

    let cache = AstCache::new();
    let results = diff_against(&options(root, true, vec![]), &cache).unwrap();

    assert_eq!(results.len(), 1);
    assert_eq!(results[0].status, FileStatus::Modified);
}

#[test]
fn forced_repo_colour_does_not_hide_unstaged_parsed_diff() {
    let repo = setup_git_repo();
    let root = repo.path();
    git(root, &["config", "color.ui", "always"]);
    std::fs::write(root.join("test.rs"), "pub fn forced_colour_unstaged() {}\n").unwrap();

    assert_git_diff_is_coloured(root, false, &["test.rs"]);

    let cache = AstCache::new();
    let results = diff_against(&options(root, false, vec!["test.rs"]), &cache).unwrap();
    assert_eq!(results.len(), 1, "the modified file must be detected");
    assert_eq!(results[0].path, "test.rs");
    assert_eq!(results[0].status, FileStatus::Modified);
}

#[test]
fn forced_repo_colour_does_not_hide_staged_parsed_diff() {
    let repo = setup_git_repo();
    let root = repo.path();
    git(root, &["config", "color.diff", "always"]);
    std::fs::write(root.join("test.rs"), "pub fn forced_colour_staged() {}\n").unwrap();
    git(root, &["add", "test.rs"]);

    assert_git_diff_is_coloured(root, true, &["test.rs"]);

    let cache = AstCache::new();
    let results = diff_against(&options(root, true, vec![]), &cache).unwrap();
    assert_eq!(results.len(), 1, "the staged file must be detected");
    assert_eq!(results[0].path, "test.rs");
    assert_eq!(results[0].status, FileStatus::Modified);
}

#[test]
fn forced_repo_colour_preserves_multiple_paths_and_no_change_control() {
    let repo = setup_git_repo();
    let root = repo.path();
    git(root, &["config", "color.ui", "always"]);
    std::fs::write(root.join("space name.rs"), "pub fn space_before() {}\n").unwrap();
    std::fs::write(root.join("unicode-λ.rs"), "pub fn unicode_before() {}\n").unwrap();
    git(root, &["add", "space name.rs", "unicode-λ.rs"]);
    git(root, &["commit", "-m", "track special paths"]);
    std::fs::write(root.join("space name.rs"), "pub fn with_space() {}\n").unwrap();
    std::fs::write(root.join("unicode-λ.rs"), "pub fn unicode_name() {}\n").unwrap();

    assert_git_diff_is_coloured(root, false, &["space name.rs", "unicode-λ.rs"]);

    let cache = AstCache::new();
    let results = diff_against(
        &options(root, false, vec!["space name.rs", "unicode-λ.rs"]),
        &cache,
    )
    .unwrap();
    let mut paths: Vec<_> = results.into_iter().map(|result| result.path).collect();
    paths.sort();
    assert_eq!(paths, vec!["space name.rs", "unicode-λ.rs"]);

    let pristine = setup_git_repo();
    git(pristine.path(), &["config", "color.ui", "always"]);
    let no_change =
        diff_against(&options(pristine.path(), false, vec![]), &AstCache::new()).unwrap();
    assert!(no_change.is_empty(), "no-change control must remain empty");
}
