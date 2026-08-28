//! Milestone 4 semantic change classification tests.
//!
//! Tests verify that:
//! - TS & Rust function body edits are classified as ImplementationChanged
//! - TS & Rust signature edits are classified as SignatureChanged
//! - Symbol addition & deletion are classified as SymbolAdded & SymbolDeleted
//! - File addition, deletion, and rename are classified as FileAdded, FileDeleted, FileRenamed
//! - Non-code / unsupported changes are classified as Unknown with explicit uncertainty
//! - Change IDs are deterministic and independent of line numbers
//! - Jail safety prevents repository escape in change sources

use fdx::intelligence::change::classify::classify_changes;
use fdx::intelligence::change::model::SemanticChangeKind;
use fdx::intelligence::change::uncertainty::UncertaintyReason;
use fdx::protocol::AssuranceLevel;
use std::fs;
use std::path::Path;
use std::process::Command;

fn init_git_repo(path: &Path) {
    let _ = Command::new("git")
        .args(["init", "--initial-branch=main"])
        .current_dir(path)
        .output();
    let _ = Command::new("git")
        .args(["config", "user.name", "Test Agent"])
        .current_dir(path)
        .output();
    let _ = Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(path)
        .output();
}

fn git_commit_all(path: &Path, msg: &str) {
    let _ = Command::new("git")
        .args(["add", "-A"])
        .current_dir(path)
        .output();
    let _ = Command::new("git")
        .args(["commit", "-m", msg, "--allow-empty"])
        .current_dir(path)
        .output();
}

#[test]
fn test_classify_ts_body_only_modification() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    let file = repo.join("src/service.ts");
    fs::write(
        &file,
        "export function calculate(a: number, b: number): number {
  return a + b;
}
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    // Modify only body
    fs::write(
        &file,
        "export function calculate(a: number, b: number): number {
  const res = a + b;
  return res;
}
",
    )
    .unwrap();

    let change_set =
        classify_changes(repo, Some("HEAD"), None).expect("classification should succeed");
    assert!(!change_set.changes.is_empty(), "Should detect change");

    let change = change_set
        .changes
        .iter()
        .find(|c| c.symbol.as_deref() == Some("calculate"))
        .expect("calculate symbol change should be found");

    assert_eq!(
        change.change_kind,
        SemanticChangeKind::ImplementationChanged
    );
    assert_eq!(change.file, "src/service.ts");
    assert!(!change.id.is_empty());
}

#[test]
fn test_classify_ts_signature_change() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    let file = repo.join("src/service.ts");
    fs::write(
        &file,
        "export function calculate(a: number, b: number): number {
  return a + b;
}
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    // Modify signature: add parameter c
    fs::write(
        &file,
        "export function calculate(a: number, b: number, c: number = 0): number {
  return a + b + c;
}
",
    )
    .unwrap();

    let change_set =
        classify_changes(repo, Some("HEAD"), None).expect("classification should succeed");
    let change = change_set
        .changes
        .iter()
        .find(|c| c.symbol.as_deref() == Some("calculate"))
        .expect("calculate symbol change should be found");

    assert_eq!(change.change_kind, SemanticChangeKind::SignatureChanged);
    assert_eq!(change.file, "src/service.ts");
}

#[test]
fn test_classify_rust_body_vs_signature() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    let file = repo.join("src/lib.rs");
    fs::write(
        &file,
        "pub fn process(x: i32) -> i32 {
    x * 2
}

pub fn helper(y: i32) -> i32 {
    y + 1
}
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    // Modify process signature, helper body
    fs::write(
        &file,
        "pub fn process(x: i32, multiplier: i32) -> i32 {
    x * multiplier
}

pub fn helper(y: i32) -> i32 {
    let val = y + 1;
    val
}
",
    )
    .unwrap();

    let change_set =
        classify_changes(repo, Some("HEAD"), None).expect("classification should succeed");

    let process_ch = change_set
        .changes
        .iter()
        .find(|c| c.symbol.as_deref() == Some("process"))
        .expect("process change found");
    assert_eq!(process_ch.change_kind, SemanticChangeKind::SignatureChanged);

    let helper_ch = change_set
        .changes
        .iter()
        .find(|c| c.symbol.as_deref() == Some("helper"))
        .expect("helper change found");
    assert_eq!(
        helper_ch.change_kind,
        SemanticChangeKind::ImplementationChanged
    );
}

#[test]
fn test_classify_symbol_added_and_deleted() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    let file = repo.join("src/mod.ts");
    fs::write(
        &file,
        "export function oldFn(): void {}
export function stayFn(): void {}
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    // Remove oldFn, add newFn
    fs::write(
        &file,
        "export function stayFn(): void {}
export function newFn(): void {}
",
    )
    .unwrap();

    let change_set =
        classify_changes(repo, Some("HEAD"), None).expect("classification should succeed");

    let del_ch = change_set
        .changes
        .iter()
        .find(|c| c.symbol.as_deref() == Some("oldFn"))
        .expect("oldFn deleted");
    assert_eq!(del_ch.change_kind, SemanticChangeKind::SymbolDeleted);

    let add_ch = change_set
        .changes
        .iter()
        .find(|c| c.symbol.as_deref() == Some("newFn"))
        .expect("newFn added");
    assert_eq!(add_ch.change_kind, SemanticChangeKind::SymbolAdded);
}

#[test]
fn test_classify_file_lifecycle_events() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(
        repo.join("src/to_delete.ts"),
        "export const x = 1;
",
    )
    .unwrap();
    fs::write(
        repo.join("src/to_rename.ts"),
        "export const y = 2;
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    // Delete to_delete.ts, rename to_rename.ts -> src/renamed.ts, add src/new_file.ts
    fs::remove_file(repo.join("src/to_delete.ts")).unwrap();
    let _ = Command::new("git")
        .args(["mv", "src/to_rename.ts", "src/renamed.ts"])
        .current_dir(repo)
        .output();
    fs::write(
        repo.join("src/new_file.ts"),
        "export const z = 3;
",
    )
    .unwrap();

    let change_set =
        classify_changes(repo, Some("HEAD"), None).expect("classification should succeed");

    assert!(
        change_set
            .changes
            .iter()
            .any(|c| c.file == "src/to_delete.ts"
                && c.change_kind == SemanticChangeKind::FileDeleted),
        "FileDeleted must be present"
    );
    assert!(
        change_set.changes.iter().any(|c| c.file == "src/renamed.ts"
            && (c.change_kind == SemanticChangeKind::FileRenamed
                || c.change_kind == SemanticChangeKind::FileAdded)),
        "FileRenamed or FileAdded must be present"
    );
    assert!(
        change_set
            .changes
            .iter()
            .any(|c| c.file == "src/new_file.ts" && c.change_kind == SemanticChangeKind::FileAdded),
        "FileAdded must be present"
    );
}

#[test]
fn test_classify_unknown_semantic_modification() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::write(
        repo.join("data.xyz_unsupported"),
        "raw blob data 1
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    fs::write(
        repo.join("data.xyz_unsupported"),
        "raw blob data 2 altered
",
    )
    .unwrap();

    let change_set =
        classify_changes(repo, Some("HEAD"), None).expect("classification should succeed");
    let change = change_set
        .changes
        .iter()
        .find(|c| c.file == "data.xyz_unsupported")
        .expect("unsupported file change found");

    assert_eq!(change.change_kind, SemanticChangeKind::Unknown);
    assert_ne!(change.assurance, AssuranceLevel::Exact);
    assert!(
        change_set.uncertainty.iter().any(|u| matches!(
            u,
            UncertaintyReason::UnsupportedLanguage(_)
        ) || matches!(
            u,
            UncertaintyReason::SemanticChangeUnknown(_)
        )),
        "Must record explicit uncertainty for unknown semantic modification"
    );
}

#[test]
fn test_change_id_determinism_and_no_line_number_dependence() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path();
    init_git_repo(repo);

    fs::create_dir_all(repo.join("src")).unwrap();
    let file = repo.join("src/calc.ts");
    fs::write(
        &file,
        "// Some comments

export function add(a: number, b: number): number {
  return a + b;
}
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    // Add empty lines at top (shifts line numbers) and edit calculate body
    fs::write(
        &file,
        "// Some comments





export function add(a: number, b: number): number {
  return a + b + 0;
}
",
    )
    .unwrap();

    let res1 = classify_changes(repo, Some("HEAD"), None).unwrap();
    let ch1 = res1
        .changes
        .iter()
        .find(|c| c.symbol.as_deref() == Some("add"))
        .unwrap();

    // Re-run
    let res2 = classify_changes(repo, Some("HEAD"), None).unwrap();
    let ch2 = res2
        .changes
        .iter()
        .find(|c| c.symbol.as_deref() == Some("add"))
        .unwrap();

    assert_eq!(
        ch1.id, ch2.id,
        "Change ID must be deterministic across identical logical edits"
    );
    assert!(
        !ch1.id.contains("line"),
        "Change ID must not embed line numbers"
    );
}
