use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use tempfile::tempdir;

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_fdx")
}

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

fn init_repo(repo: &Path) {
    git(repo, &["init"]);
    git(repo, &["config", "user.name", "test"]);
    git(repo, &["config", "user.email", "t@t.test"]);
    fs::create_dir_all(repo.join("src")).unwrap();
    fs::write(repo.join("src/foo.ts"), "const a = 1;").unwrap();
    git(repo, &["add", "."]);
    git(repo, &["commit", "-m", "init"]);
}

fn run_cmd(repo: &Path, args: &[&str]) -> String {
    let out = Command::new(bin())
        .args(args)
        .current_dir(repo)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "cmd {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).to_string()
}

#[test]
fn test_cli_renders_degraded_for_oversized_file() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    init_repo(repo);

    // Index the small file first (clean), then add an oversized file and refresh.
    let out1 = run_cmd(repo, &["index", "run"]);
    assert!(out1.contains("INDEX fresh"), "got: {}", out1);

    let big = vec![0u8; 11 * 1024 * 1024];
    fs::write(repo.join("src/big.bin"), &big).unwrap();

    let out2 = run_cmd(repo, &["index", "run"]);
    assert!(out2.contains("INDEX degraded"), "got: {}", out2);
    assert!(out2.contains("reason=file_too_large"), "got: {}", out2);
    assert!(out2.contains("skipped=1"), "got: {}", out2);
    assert!(
        !out2.contains("INDEX fresh"),
        "must not print fresh: {}",
        out2
    );

    let status = run_cmd(repo, &["index", "status"]);
    assert!(status.contains("INDEX degraded"), "got: {}", status);
}

#[test]
fn test_daemon_nested_cwd_resolves_root_and_shared_status() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    init_repo(repo);
    run_cmd(repo, &["index", "run"]);

    let nested = repo.join("src").join("deep");
    fs::create_dir_all(&nested).unwrap();

    // CLI status from root
    let cli_status = run_cmd(repo, &["index", "status"]);
    let cli_generation = cli_status
        .lines()
        .find(|l| l.starts_with("generation="))
        .map(|l| l.to_string())
        .unwrap_or_else(|| panic!("no generation in: {}", cli_status));

    // Daemon launched from a nested cwd
    let mut child = Command::new(bin())
        .arg("serve")
        .current_dir(&nested)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(
            stdin,
            "{}",
            serde_json::json!({"id":"r1","op":"evidence-graph-v1","args":{}})
        )
        .unwrap();
        stdin.flush().unwrap();
    }

    let mut line = String::new();
    {
        let stdout = child.stdout.as_mut().unwrap();
        let mut reader = BufReader::new(stdout);
        reader.read_line(&mut line).unwrap();
    }
    child.kill().unwrap();
    let _ = child.wait();

    let resp: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(resp["ok"], true, "got: {}", line);
    assert_eq!(resp["value"]["status"], "fresh", "got: {}", line);
    // Same generation as CLI status from root
    assert_eq!(
        format!("generation={}", resp["value"]["generation"]),
        cli_generation,
        "daemon and CLI must share one status: {} vs {}",
        line,
        cli_status
    );
    assert_eq!(resp["value"]["foreign_keys"], true);
}

#[test]
fn test_daemon_absent_db_reports_absent_and_creates_nothing() {
    let dir = tempdir().unwrap();
    let repo = dir.path();
    init_repo(repo); // no .fdx yet

    let nested = repo.join("src");
    let mut child = Command::new(bin())
        .arg("serve")
        .current_dir(&nested)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();

    {
        let stdin = child.stdin.as_mut().unwrap();
        writeln!(
            stdin,
            "{}",
            serde_json::json!({"id":"r2","op":"evidence-graph-v1","args":{}})
        )
        .unwrap();
        stdin.flush().unwrap();
    }

    let mut line = String::new();
    {
        let stdout = child.stdout.as_mut().unwrap();
        let mut reader = BufReader::new(stdout);
        reader.read_line(&mut line).unwrap();
    }
    child.kill().unwrap();
    let _ = child.wait();

    let resp: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(resp["ok"], true, "got: {}", line);
    assert_eq!(resp["value"]["status"], "absent", "got: {}", line);

    // Daemon must not create .fdx anywhere
    assert!(!repo.join(".fdx").exists(), "daemon created .fdx");
    assert!(!nested.join(".fdx").exists(), "daemon created nested .fdx");
}
