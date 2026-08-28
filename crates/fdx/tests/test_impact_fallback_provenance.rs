//! Milestone 4 fallback provenance tests.

use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::protocol::EvidenceStrength;
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
fn test_lexical_fallback_is_labeled_manual_rule_heuristic_never_tree_sitter() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path();
    init_git_repo(repo);

    let file_a = repo.join("util.ts");
    let file_b = repo.join("main.ts");

    fs::write(
        &file_a,
        "export function helper() { return 1; }
",
    )
    .unwrap();
    fs::write(
        &file_b,
        "import { helper } from './util';
export function main() { return helper(); }
",
    )
    .unwrap();
    git_commit_all(repo, "initial");

    // Modify helper
    fs::write(
        &file_a,
        "export function helper(): number { return 2; }
",
    )
    .unwrap();

    // No DB initialized -> purely fallback traversal
    let result = analyze_impact_v2(repo, Some("HEAD"), None, Some(3)).unwrap();

    // Find main.ts target
    let main_target = result.impacted.iter().find(|t| t.target == "main.ts");
    assert!(main_target.is_some(), "main.ts must be found via fallback");

    let prim_path = main_target.unwrap().primary_path.as_ref().unwrap();
    for step in &prim_path.steps {
        if step.provider != "change-delta" {
            // Must be labeled manual_rule and Heuristic, never tree_sitter or Structural!
            assert_eq!(
                step.provider, "manual_rule",
                "Lexical line/token scanning must be labeled 'manual_rule'"
            );
            assert_eq!(
                step.strength,
                EvidenceStrength::Heuristic,
                "Lexical fallback strength must be Heuristic"
            );
        }
    }
}
