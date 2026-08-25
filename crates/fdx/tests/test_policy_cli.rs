use fdx::intelligence::db::{DatabaseOpenMode, EvidenceDatabase};
use fdx::intelligence::policy::{generate_candidates, PromotionPolicy};
use rusqlite::params;
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::tempdir;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_fdx")
}

fn git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn run(repo: &Path, args: &[&str]) -> String {
    let output = Command::new(bin())
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "fdx {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn insert_qualified_shadow_miss(
    db: &EvidenceDatabase,
    calibration_id: &str,
    started_at_ms: i64,
    artifact: &str,
    record: &str,
) {
    db.conn
        .execute(
            r#"INSERT INTO calibration_runs (
                calibration_id, source_run_id, candidate_plan_digest, policy_digest, status,
                reference_scope, max_shadow_checks, reference_truncated, started_at_ms,
                completed_at_ms, duration_ms, created_at_ms, calibration_contract_version,
                source_artifact_sha256, record_digest, max_total_duration_ms,
                per_check_timeout_ms, max_output_bytes
            ) VALUES (?1, ?2, ?3, 'measurement-only', 'complete', 'affected', 5, 0, ?4, ?5,
                      10, ?5, 2, ?6, ?7, 1000, 100, 4096)"#,
            params![
                calibration_id,
                format!("run-{calibration_id}"),
                format!("plan-{calibration_id}"),
                started_at_ms,
                started_at_ms + 10,
                artifact,
                record,
            ],
        )
        .unwrap();
    db.conn
        .execute(
            r#"INSERT INTO calibration_metrics (
                calibration_id, candidate_selected_count, shadow_reference_count,
                shadow_executed_count, candidate_physical_execution_count,
                shadow_physical_execution_count, selected_failure_count,
                unselected_failure_count, observed_shadow_miss_count,
                shadow_incomplete_count, candidate_execution_duration_ms,
                shadow_reference_duration_ms, selection_ratio, runtime_cost_ratio,
                signal_recall, eligible_for_miss_rate, eligible_for_cost_ratio,
                eligible_for_runtime_comparison
            ) VALUES (?1, 1, 2, 1, 1, 1, 1, 1, 1, 0, 10, 20, 0.5, 0.5, 0.5, 1, 1, 1)"#,
            params![calibration_id],
        )
        .unwrap();
    db.conn
        .execute(
            r#"INSERT INTO calibration_checks (
                calibration_id, check_id, candidate_selected, reference_selected,
                execution_status, has_physical_execution, duration_ms, signal_class,
                is_observed_shadow_miss, reason, display_name, kind, scope,
                execution_id, reused_execution
            ) VALUES (?1, 'check:pkg:npm:.:format', 0, 1, 'failed', 1, 20,
                      'observed_shadow_miss', 1, NULL, 'format', 'format', 'pkg:npm:.', NULL, 0)"#,
            params![calibration_id],
        )
        .unwrap();
}

fn init_repo(repo: &Path) {
    git(repo, &["init"]);
    git(repo, &["config", "user.name", "test"]);
    git(repo, &["config", "user.email", "test@example.invalid"]);
    fs::create_dir_all(repo.join("src")).unwrap();
    fs::create_dir_all(repo.join("tests")).unwrap();
    fs::write(
        repo.join("package.json"),
        r#"{"name":"m11-fixture","scripts":{"test":"true","typecheck":"true","lint":"true","format":"true"}}"#,
    )
    .unwrap();
    fs::write(repo.join("package-lock.json"), "{\"lockfileVersion\":3}\n").unwrap();
    fs::write(repo.join("src/lib.ts"), "export const value = 1;\n").unwrap();
    fs::write(repo.join("tests/lib.test.ts"), "export {};\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "base"]);
    fs::write(repo.join("src/lib.ts"), "export const value = 2;\n").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "change"]);
}

#[test]
fn test_policy_cli_promotes_exact_template_preserves_default_plan_and_persists_verify_application()
{
    let dir = tempdir().unwrap();
    let repo = dir.path();
    init_repo(repo);
    let mut db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    insert_qualified_shadow_miss(&db, "cli-a", 200, "artifact-cli-a", "record-cli-a");
    insert_qualified_shadow_miss(&db, "cli-b", 100, "artifact-cli-b", "record-cli-b");
    let policy = PromotionPolicy::default();
    let candidate = generate_candidates(&mut db.conn, &policy, 1_000)
        .unwrap()
        .remove(0);
    drop(db);

    let base_args = ["--base", "HEAD~1", "--head", "HEAD", "--format", "json"];
    let mut default_plan_args = vec!["plan"];
    default_plan_args.extend(base_args);
    let default_before = run(repo, &default_plan_args);
    let promoted: serde_json::Value = serde_json::from_str(&run(
        repo,
        &[
            "policy",
            "promote-candidate",
            &candidate.candidate_id,
            "--format",
            "json",
        ],
    ))
    .unwrap();
    let policy_id = promoted["policy_id"].as_str().unwrap().to_string();
    assert!(promoted["template_digest"]
        .as_str()
        .unwrap()
        .starts_with(|c: char| c.is_ascii_hexdigit()));

    let active: serde_json::Value =
        serde_json::from_str(&run(repo, &["policy", "list-active", "--format", "json"])).unwrap();
    assert_eq!(active["policies"].as_array().unwrap().len(), 1);
    assert_eq!(active["policies"][0]["policy_id"], policy_id);
    assert_eq!(
        active["policies"][0]["template_digest"],
        promoted["template_digest"]
    );

    let default_after = run(repo, &default_plan_args);
    assert_eq!(
        default_before, default_after,
        "default M6 plan output changed after M11 policy promotion"
    );
    let default_plan: serde_json::Value = serde_json::from_str(&default_after).unwrap();
    assert!(default_plan["selected_checks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|check| check["check_id"] != "check:pkg:npm:.:format"));

    let mut overlay_plan_args = vec!["plan", "--policy-overlay"];
    overlay_plan_args.extend(base_args);
    let overlay: serde_json::Value = serde_json::from_str(&run(repo, &overlay_plan_args)).unwrap();
    assert_eq!(overlay["plan"]["assurance"], default_plan["assurance"]);
    assert_eq!(
        overlay["plan"]["unresolved_obligations"],
        default_plan["unresolved_obligations"]
    );
    assert_eq!(
        overlay["added_check_ids"],
        serde_json::json!(["check:pkg:npm:.:format"])
    );

    let no_persist = run(
        repo,
        &[
            "verify",
            "--policy-overlay",
            "--base",
            "HEAD~1",
            "--head",
            "HEAD",
            "--no-persist",
            "--format",
            "json",
        ],
    );
    assert!(!no_persist.is_empty());
    let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let count_after_no_persist: i64 = db
        .conn
        .query_row("SELECT count(*) FROM policy_applications", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count_after_no_persist, 0);
    drop(db);

    let persisted = run(
        repo,
        &[
            "verify",
            "--policy-overlay",
            "--base",
            "HEAD~1",
            "--head",
            "HEAD",
            "--format",
            "json",
        ],
    );
    assert!(!persisted.is_empty());
    let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let application_count: i64 = db
        .conn
        .query_row("SELECT count(*) FROM policy_applications", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(application_count, 1);
    drop(db);

    let revoked: serde_json::Value = serde_json::from_str(&run(
        repo,
        &[
            "policy",
            "revoke-policy",
            &policy_id,
            "--reason",
            "operator_review",
            "--format",
            "json",
        ],
    ))
    .unwrap();
    assert_eq!(revoked["state"], "revoked");
    let active_after_revoke: serde_json::Value =
        serde_json::from_str(&run(repo, &["policy", "list-active", "--format", "json"])).unwrap();
    assert!(active_after_revoke["policies"]
        .as_array()
        .unwrap()
        .is_empty());
    let db = EvidenceDatabase::open(repo, DatabaseOpenMode::ReadWrite).unwrap();
    let evidence_count: i64 = db
        .conn
        .query_row(
            "SELECT count(*) FROM policy_candidate_evidence",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let event_count: i64 = db
        .conn
        .query_row("SELECT count(*) FROM policy_events", [], |row| row.get(0))
        .unwrap();
    let application_count_after_revoke: i64 = db
        .conn
        .query_row("SELECT count(*) FROM policy_applications", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(evidence_count, 2);
    assert_eq!(event_count, 2);
    assert_eq!(application_count_after_revoke, 1);
}
