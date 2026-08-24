use std::process::Command;
use tempfile::tempdir;

#[test]
fn test_calibration_cli_subcommands() {
    let binary = env!("CARGO_BIN_EXE_fdx");
    let dir = tempdir().unwrap();
    let repo_root = dir.path();

    // 1. Initialize repo structure with an M7 verification run
    let fdx_dir = repo_root.join(".fdx");
    let runs_dir = fdx_dir.join("runs");
    std::fs::create_dir_all(&runs_dir).unwrap();

    let run_id = "019184a2-7b3e-7b3c-9452-19e491c1d810";
    let run_file = runs_dir.join(format!("{}.json", run_id));

    let run_json = serde_json::json!({
        "run_id": run_id,
        "plan": {
            "assurance": "EXACT",
            "changed": [],
            "impacted_targets": [],
            "selected_checks": [
                {
                    "check_id": "test:cargo:tests/test_a.rs",
                    "display_name": "tests/test_a.rs",
                    "kind": "integration_test",
                    "scope": "pkg:cargo:crates/a",
                    "reason": "selected",
                    "selection": "evidence",
                    "strength": "precise",
                    "mandatory": false
                }
            ],
            "uncertainty": [],
            "unresolved_obligations": []
        },
        "outcome": "passed",
        "assurance": "EXACT",
        "checks": [
            {
                "check_id": "test:cargo:tests/test_a.rs",
                "kind": "integration_test",
                "status": "passed",
                "execution_id": "exec_1",
                "reused_execution": false,
                "command": ["cargo", "test"],
                "cwd": ".",
                "exit_code": 0,
                "duration_ms": 20,
                "started_at_ms": 1000,
                "stdout_truncated": false,
                "stderr_truncated": false
            }
        ],
        "uncertainty": [],
        "persistence_status": {
            "status": "persisted",
            "path": format!(".fdx/runs/{}.json", run_id)
        },
        "executed_at_ms": 1000,
        "duration_ms": 20
    });

    std::fs::write(&run_file, serde_json::to_vec(&run_json).unwrap()).unwrap();

    // 2. Run calibration via CLI
    let output = Command::new(binary)
        .current_dir(repo_root)
        .args(["calibrate", "run", "--run", run_id, "--format", "json"])
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "calibrate run should succeed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let cal_json: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let cal_id = cal_json["calibration_id"].as_str().unwrap();

    // 3. List calibrations via CLI
    let list_output = Command::new(binary)
        .current_dir(repo_root)
        .args(["calibrate", "list", "--format", "json"])
        .output()
        .unwrap();

    assert!(list_output.status.success());
    let list_json: serde_json::Value = serde_json::from_slice(&list_output.stdout).unwrap();
    assert_eq!(list_json.as_array().unwrap().len(), 1);

    // 4. Show calibration via CLI
    let show_output = Command::new(binary)
        .current_dir(repo_root)
        .args(["calibrate", "show", cal_id, "--format", "json"])
        .output()
        .unwrap();

    assert!(show_output.status.success());

    // 5. Query stats via CLI
    let stats_output = Command::new(binary)
        .current_dir(repo_root)
        .args(["calibrate", "stats", "--format", "json"])
        .output()
        .unwrap();

    assert!(stats_output.status.success());
    let stats_json: serde_json::Value = serde_json::from_slice(&stats_output.stdout).unwrap();
    assert_eq!(stats_json["total_calibrations"].as_u64().unwrap(), 1);
}
