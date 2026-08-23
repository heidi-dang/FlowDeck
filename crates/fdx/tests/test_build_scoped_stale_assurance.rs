//! Milestone 5 Trust Proof: Strict Stale Scope Isolation Against Control.

use fdx::intelligence::change::traverse::analyze_impact_v2;
use fdx::protocol::AssuranceLevel;
use std::fs;
use tempfile::tempdir;

fn init_git(dir: &std::path::Path) {
    std::process::Command::new("git")
        .args(["init", "--initial-branch=main"])
        .current_dir(dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["config", "user.name", "Test Runner"])
        .current_dir(dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(dir)
        .output()
        .unwrap();
}

fn commit_all(dir: &std::path::Path, msg: &str) {
    std::process::Command::new("git")
        .args(["add", "-A"])
        .current_dir(dir)
        .output()
        .unwrap();
    std::process::Command::new("git")
        .args(["commit", "-m", msg, "--allow-empty"])
        .current_dir(dir)
        .output()
        .unwrap();
}

#[test]
fn test_npm_stale_scope_isolation_against_control() {
    // 1. TEST REPOSITORY: Disconnected pkg-a and pkg-b
    let tmp_test = tempdir().unwrap();
    let test_root = tmp_test.path();
    init_git(test_root);

    fs::write(
        test_root.join("package.json"),
        serde_json::json!({
            "name": "root",
            "private": true,
            "workspaces": ["packages/*"]
        })
        .to_string(),
    )
    .unwrap();

    let pdir_a = test_root.join("packages/pkg-a/src");
    fs::create_dir_all(&pdir_a).unwrap();
    fs::write(pdir_a.join("index.ts"), "export const a = 1;").unwrap();
    fs::write(
        test_root.join("packages/pkg-a/package.json"),
        serde_json::json!({ "name": "@app/pkg-a", "version": "1.0.0" }).to_string(),
    )
    .unwrap();

    let pdir_b = test_root.join("packages/pkg-b/src");
    fs::create_dir_all(&pdir_b).unwrap();
    fs::write(pdir_b.join("index.ts"), "export const b = 1;").unwrap();
    fs::write(
        test_root.join("packages/pkg-b/package.json"),
        serde_json::json!({ "name": "@app/pkg-b", "version": "1.0.0" }).to_string(),
    )
    .unwrap();

    commit_all(test_root, "init test repo");
    let _ =
        fdx::intelligence::build::ingest::refresh_all_build_providers(test_root, false).unwrap();

    // 2. CONTROL REPOSITORY: Clean pkg-b only
    let tmp_ctrl = tempdir().unwrap();
    let ctrl_root = tmp_ctrl.path();
    init_git(ctrl_root);

    fs::write(
        ctrl_root.join("package.json"),
        serde_json::json!({
            "name": "root",
            "private": true,
            "workspaces": ["packages/*"]
        })
        .to_string(),
    )
    .unwrap();

    let ctrl_pdir_b = ctrl_root.join("packages/pkg-b/src");
    fs::create_dir_all(&ctrl_pdir_b).unwrap();
    fs::write(ctrl_pdir_b.join("index.ts"), "export const b = 1;").unwrap();
    fs::write(
        ctrl_root.join("packages/pkg-b/package.json"),
        serde_json::json!({ "name": "@app/pkg-b", "version": "1.0.0" }).to_string(),
    )
    .unwrap();

    commit_all(ctrl_root, "init control repo");
    let _ =
        fdx::intelligence::build::ingest::refresh_all_build_providers(ctrl_root, false).unwrap();

    // In Test repo: Modify pkg-a/package.json (making provider stale for pkg-a) AND modify pkg-b/src/index.ts
    fs::write(
        test_root.join("packages/pkg-a/package.json"),
        serde_json::json!({ "name": "@app/pkg-a", "version": "1.0.1", "description": "stale" })
            .to_string(),
    )
    .unwrap();
    fs::write(pdir_b.join("index.ts"), "export const b = 2;").unwrap();

    // In Control repo: Modify pkg-b/src/index.ts
    fs::write(ctrl_pdir_b.join("index.ts"), "export const b = 2;").unwrap();

    let test_res = analyze_impact_v2(test_root, Some("HEAD"), None, Some(3)).unwrap();
    let ctrl_res = analyze_impact_v2(ctrl_root, Some("HEAD"), None, Some(3)).unwrap();

    // STRICT CONTROL COMPARISONS:
    // 1. Top-level assurance equality
    assert_eq!(
        test_res.assurance, ctrl_res.assurance,
        "Test repository assurance must match control repository assurance for fresh pkg-b"
    );

    // 2. B target present in both
    let test_b = test_res
        .impacted
        .iter()
        .find(|t| t.target.contains("pkg-b"))
        .expect("pkg-b must be present in test impacted set");
    let ctrl_b = ctrl_res
        .impacted
        .iter()
        .find(|t| t.target.contains("pkg-b"))
        .expect("pkg-b must be present in control impacted set");

    // 3. Evidence strengths equal
    assert_eq!(test_b.strength, ctrl_b.strength);

    // 4. Primary path edge kinds and evidence strengths equal
    let test_path = test_b.primary_path.as_ref().unwrap();
    let ctrl_path = ctrl_b.primary_path.as_ref().unwrap();
    let test_kinds: Vec<_> = test_path.steps.iter().map(|s| s.edge_kind).collect();
    let ctrl_kinds: Vec<_> = ctrl_path.steps.iter().map(|s| s.edge_kind).collect();
    assert_eq!(test_kinds, ctrl_kinds);

    let test_strengths: Vec<_> = test_path.steps.iter().map(|s| s.strength).collect();
    let ctrl_strengths: Vec<_> = ctrl_path.steps.iter().map(|s| s.strength).collect();
    assert_eq!(test_strengths, ctrl_strengths);

    // 5. Stale uncertainty for A exists as a diagnostic, but does NOT degrade B's assurance
    assert!(
        test_res
            .uncertainty
            .iter()
            .any(|u| u.code() == "build_provider_stale"),
        "A's stale state must be captured as a diagnostic"
    );
    assert_eq!(test_res.assurance, AssuranceLevel::Degraded);
}

#[test]
fn test_tsconfig_stale_scope_isolation_against_control() {
    let tmp_test = tempdir().unwrap();
    let test_root = tmp_test.path();
    init_git(test_root);

    // Test repo: proj-a and proj-b
    for name in ["a", "b"] {
        let dir = test_root.join(format!("proj-{}", name));
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/index.ts"), "export const x = 1;").unwrap();
        fs::write(
            dir.join("tsconfig.json"),
            serde_json::json!({ "compilerOptions": { "composite": true } }).to_string(),
        )
        .unwrap();
    }
    commit_all(test_root, "init test");
    let _ =
        fdx::intelligence::build::ingest::refresh_all_build_providers(test_root, false).unwrap();

    // Control repo: proj-b only
    let tmp_ctrl = tempdir().unwrap();
    let ctrl_root = tmp_ctrl.path();
    init_git(ctrl_root);

    let ctrl_dir_b = ctrl_root.join("proj-b");
    fs::create_dir_all(ctrl_dir_b.join("src")).unwrap();
    fs::write(ctrl_dir_b.join("src/index.ts"), "export const x = 1;").unwrap();
    fs::write(
        ctrl_dir_b.join("tsconfig.json"),
        serde_json::json!({ "compilerOptions": { "composite": true } }).to_string(),
    )
    .unwrap();
    commit_all(ctrl_root, "init ctrl");
    let _ =
        fdx::intelligence::build::ingest::refresh_all_build_providers(ctrl_root, false).unwrap();

    // In Test repo: Modify proj-a/tsconfig.json (stale for a) AND proj-b/src/index.ts
    fs::write(
        test_root.join("proj-a/tsconfig.json"),
        serde_json::json!({ "compilerOptions": { "composite": true, "declaration": true } })
            .to_string(),
    )
    .unwrap();
    fs::write(test_root.join("proj-b/src/index.ts"), "export const x = 2;").unwrap();

    // In Control repo: Modify proj-b/src/index.ts
    fs::write(ctrl_dir_b.join("src/index.ts"), "export const x = 2;").unwrap();

    let test_res = analyze_impact_v2(test_root, Some("HEAD"), None, Some(3)).unwrap();
    let ctrl_res = analyze_impact_v2(ctrl_root, Some("HEAD"), None, Some(3)).unwrap();

    assert_eq!(test_res.assurance, ctrl_res.assurance);
    assert_eq!(test_res.assurance, AssuranceLevel::Degraded);

    // Verify proj-b impact target, depth, and strength match control exactly
    let test_b_tgt = test_res.impacted.iter().find(|t| t.target.contains("proj-b")).expect("proj-b must be impacted in test");
    let ctrl_b_tgt = ctrl_res.impacted.iter().find(|t| t.target.contains("proj-b")).expect("proj-b must be impacted in ctrl");
    assert_eq!(test_b_tgt.depth, ctrl_b_tgt.depth);
    assert_eq!(test_b_tgt.strength, ctrl_b_tgt.strength);
    assert_eq!(test_b_tgt.target_kind, ctrl_b_tgt.target_kind);
}

#[test]
fn test_cargo_stale_scope_isolation_against_control() {
    let tmp_test = tempdir().unwrap();
    let test_root = tmp_test.path();
    init_git(test_root);

    // Test repo: crate-a and crate-b
    fs::write(
        test_root.join("Cargo.toml"),
        r#"[workspace]
members = ["crates/crate-a", "crates/crate-b"]
"#,
    )
    .unwrap();

    for name in ["crate-a", "crate-b"] {
        let dir = test_root.join("crates").join(name);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/lib.rs"), "pub fn run() {}").unwrap();
        fs::write(
            dir.join("Cargo.toml"),
            format!(
                r#"[package]
name = "{}"
version = "0.1.0"
edition = "2021"
"#,
                name
            ),
        )
        .unwrap();
    }
    commit_all(test_root, "init test");
    let _ =
        fdx::intelligence::build::ingest::refresh_all_build_providers(test_root, false).unwrap();

    // Control repo: crate-b only
    let tmp_ctrl = tempdir().unwrap();
    let ctrl_root = tmp_ctrl.path();
    init_git(ctrl_root);

    fs::write(
        ctrl_root.join("Cargo.toml"),
        r#"[workspace]
members = ["crates/crate-b"]
"#,
    )
    .unwrap();
    let ctrl_b = ctrl_root.join("crates/crate-b");
    fs::create_dir_all(ctrl_b.join("src")).unwrap();
    fs::write(ctrl_b.join("src/lib.rs"), "pub fn run() {}").unwrap();
    fs::write(
        ctrl_b.join("Cargo.toml"),
        r#"[package]
name = "crate-b"
version = "0.1.0"
edition = "2021"
"#,
    )
    .unwrap();
    commit_all(ctrl_root, "init ctrl");
    let _ =
        fdx::intelligence::build::ingest::refresh_all_build_providers(ctrl_root, false).unwrap();

    // In Test repo: Modify crate-a/Cargo.toml (stale for a) AND crate-b/src/lib.rs
    fs::write(
        test_root.join("crates/crate-a/Cargo.toml"),
        r#"[package]
name = "crate-a"
version = "0.2.0"
edition = "2021"
"#,
    )
    .unwrap();
    fs::write(
        test_root.join("crates/crate-b/src/lib.rs"),
        r#"pub fn run() { println!("1"); }"#,
    )
    .unwrap();

    // In Control repo: Modify crate-b/src/lib.rs
    fs::write(
        ctrl_b.join("src/lib.rs"),
        r#"pub fn run() { println!("1"); }"#,
    )
    .unwrap();

    let test_res = analyze_impact_v2(test_root, Some("HEAD"), None, Some(3)).unwrap();
    let ctrl_res = analyze_impact_v2(ctrl_root, Some("HEAD"), None, Some(3)).unwrap();

    assert_eq!(test_res.assurance, ctrl_res.assurance);
    assert_eq!(test_res.assurance, AssuranceLevel::Degraded);

    // Verify crate-b impact target, depth, and strength match control exactly
    let test_b_tgt = test_res.impacted.iter().find(|t| t.target.contains("crate-b")).expect("crate-b must be impacted in test");
    let ctrl_b_tgt = ctrl_res.impacted.iter().find(|t| t.target.contains("crate-b")).expect("crate-b must be impacted in ctrl");
    assert_eq!(test_b_tgt.depth, ctrl_b_tgt.depth);
    assert_eq!(test_b_tgt.strength, ctrl_b_tgt.strength);
    assert_eq!(test_b_tgt.target_kind, ctrl_b_tgt.target_kind);
}
