//! Milestone 3 CLI + daemon integration for semantic diagnostics.
//! Fully offline: fake provider behind SCIP_TYPESCRIPT_BIN.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};

fn bin() -> String {
    env!("CARGO_BIN_EXE_fdx").to_string()
}

fn fixture(name: &str) -> String {
    format!(
        "{}/tests/fixtures/scip/{}",
        env!("CARGO_MANIFEST_DIR"),
        name
    )
}

fn write_fake_provider(dir: &Path, fixture_name: &str, mode: &str) -> std::path::PathBuf {
    let bin = dir.join("scip-typescript");
    let fixture_abs = fixture(fixture_name);
    let mut script = String::new();
    script.push_str(
        r#"#!/bin/bash
OUT=""
PREV=""
for a in "$@"; do
  if [ "$PREV" = "--output" ]; then OUT="$a"; fi
  if [ "$a" = "--version" ]; then echo "scip-typescript 0.4.0"; exit 0; fi
  PREV="$a"
done
"#,
    );
    script.push_str("MODE=");
    script.push_str(mode);
    script.push_str(
        r#"
if [ "$MODE" = "fail" ]; then echo boom >&2; exit 7; fi
"#,
    );
    script.push_str("cp ");
    script.push_str(&fixture_abs);
    script.push_str(
        r#" "$OUT"
exit 0
"#,
    );
    std::fs::write(&bin, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    bin
}

fn ts_repo(repo: &Path) {
    std::fs::create_dir_all(repo.join("src")).unwrap();
    std::fs::write(repo.join("src/a.ts"), "export function foo() {}").unwrap();
    std::fs::write(repo.join("src/b.ts"), "import { foo } from \"./a\";").unwrap();
    std::fs::write(repo.join("src/c.ts"), "let x = bar;").unwrap();
    std::fs::write(repo.join("tsconfig.json"), "{}").unwrap();
}

fn run(repo: &Path, args: &[&str], envs: &[(&str, &str)]) -> (i32, String, String) {
    let mut cmd = Command::new(bin());
    cmd.args(args).current_dir(repo);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = cmd.output().unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}
#[test]
fn cli_semantic_status_reports_no_providers_on_fresh_repo() {
    let repo = tempfile::tempdir().unwrap();
    ts_repo(repo.path());
    let (code, out, _err) = run(repo.path(), &["semantic", "status"], &[]);
    assert_eq!(code, 0);
    assert!(out.contains("SEMANTIC no providers"), "got: {}", out);
}

#[test]
fn cli_semantic_refresh_runs_fake_provider_and_status_reports_it() {
    let repo = tempfile::tempdir().unwrap();
    ts_repo(repo.path());
    let dir = tempfile::tempdir().unwrap();
    let bin = write_fake_provider(dir.path(), "basic-ts.scip", "ok");
    let bin_str = bin.to_str().unwrap().to_string();
    let (code, out, _err) = run(
        repo.path(),
        &["semantic", "refresh", "--provider", "scip-typescript"],
        &[("SCIP_TYPESCRIPT_BIN", bin_str.as_str())],
    );
    assert_eq!(code, 0, "refresh failed: {} {}", out, _err);
    assert!(
        out.contains("SEMANTIC scip-typescript fresh"),
        "got: {}",
        out
    );
    let (code2, status, _e2) = run(
        repo.path(),
        &["semantic", "status"],
        &[("SCIP_TYPESCRIPT_BIN", bin_str.as_str())],
    );
    assert_eq!(code2, 0);
    assert!(
        status.contains("provider=scip-typescript"),
        "got: {}",
        status
    );
    assert!(status.contains("health=available"), "got: {}", status);
    assert!(status.contains("freshness=fresh"), "got: {}", status);
    assert!(status.contains("fingerprint="), "got: {}", status);
    assert!(status.contains("scope_root="), "got: {}", status);
    assert!(status.contains("reason=none"), "got: {}", status);

    // Without provider binary in env/PATH, status accurately reports effective missing/stale
    let (code3, status3, _e3) = run(repo.path(), &["semantic", "status"], &[]);
    assert_eq!(code3, 0);
    assert!(status3.contains("health=missing"), "got: {}", status3);
    assert!(status3.contains("freshness=stale"), "got: {}", status3);
}

#[test]
fn cli_semantic_refresh_missing_provider_is_truthful() {
    let repo = tempfile::tempdir().unwrap();
    ts_repo(repo.path());
    let (code, _out, _err) = run(
        repo.path(),
        &["semantic", "refresh", "--provider", "scip-typescript"],
        &[("SCIP_TYPESCRIPT_BIN", "/nonexistent/scip-typescript")],
    );
    assert_ne!(code, 0, "missing provider refresh must fail truthfully");
    let (code2, status, _e2) = run(repo.path(), &["semantic", "status"], &[]);
    assert_eq!(code2, 0);
    assert!(status.contains("health=missing"), "got: {}", status);
    assert!(status.contains("freshness=absent"), "got: {}", status);
}

#[test]
fn cli_semantic_decode_reports_bounded_stats() {
    let repo = tempfile::tempdir().unwrap();
    ts_repo(repo.path());
    let f = fixture("basic-ts.scip");
    let (code, out, _err) = run(repo.path(), &["semantic", "decode", &f], &[]);
    assert_eq!(code, 0);
    assert!(out.contains("docs=3"), "got: {}", out);
    assert!(out.contains("occurrences=5"), "got: {}", out);
    assert!(out.contains("decode_ms="), "got: {}", out);
}

#[test]
fn cli_semantic_references_fall_back_structurally_without_db() {
    let repo = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(repo.path().join("src")).unwrap();
    std::fs::write(
        repo.path().join("src/lib.rs"),
        r#"pub fn area(w: u32) -> u32 {
    w
}
fn other() {
    let a = area(2);
}"#,
    )
    .unwrap();
    let (code, out, _err) = run(
        repo.path(),
        &[
            "semantic",
            "references",
            "area",
            "--lang",
            "rust",
            "--intent",
            "reference_complete",
        ],
        &[],
    );
    assert_eq!(code, 0, "{}", _err);
    assert!(out.contains("source=TreeSitter"), "got: {}", out);
    assert!(out.contains("completeness=Conservative"), "got: {}", out);
    assert!(out.contains("strength=Structural"), "got: {}", out);
    assert!(out.contains("degraded=true"), "got: {}", out);
}
#[test]
fn daemon_semantic_status_v1_is_read_only_and_never_runs_providers() {
    let repo = tempfile::tempdir().unwrap();
    ts_repo(repo.path());
    let fdx_dir = repo.path().join(".fdx");
    // No semantic database exists yet: the op must answer absent.
    let mut child = Command::new(bin())
        .arg("serve")
        .current_dir(repo.path())
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
            serde_json::json!({"id":"r1","op":"semantic-status-v1","args":{}})
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
    let parsed: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(parsed["ok"], serde_json::Value::Bool(true));
    assert_eq!(parsed["value"]["status"], "absent");
    assert_eq!(parsed["value"]["providers"].as_array().unwrap().len(), 0);
    // The daemon must not have created any provider state or cache.
    let cache = fdx_dir.join("cache");
    assert!(!cache.exists(), "daemon must never execute providers");
}

#[test]
fn cli_references_localize_stays_lexical_with_provider_present() {
    let repo = tempfile::tempdir().unwrap();
    ts_repo(repo.path());
    let dir = tempfile::tempdir().unwrap();
    let bin = write_fake_provider(dir.path(), "basic-ts.scip", "ok");
    let bin_str = bin.to_str().unwrap().to_string();
    let (code, _out, _err) = run(
        repo.path(),
        &["semantic", "refresh", "--provider", "scip-typescript"],
        &[("SCIP_TYPESCRIPT_BIN", bin_str.as_str())],
    );
    assert_eq!(code, 0);
    let (code2, out2, _e2) = run(
        repo.path(),
        &[
            "semantic",
            "references",
            "foo",
            "--lang",
            "typescript",
            "--intent",
            "localize",
        ],
        &[],
    );
    assert_eq!(code2, 0, "{}", _e2);
    assert!(
        out2.contains("source=Lexical"),
        "localize must stay lexical: {}",
        out2
    );
    assert!(out2.contains("degraded=true"), "got: {}", out2);
}
