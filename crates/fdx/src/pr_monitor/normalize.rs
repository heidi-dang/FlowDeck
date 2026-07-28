//! Normalize a raw CI failure into a structured CiFailureReport.

use crate::pr_monitor::logs::{extract_error_excerpt, extract_exit_code};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CiFailureReport {
    pub schema_version: u8,
    pub repository: String,
    pub pr_number: i64,
    pub head_sha: String,
    pub workflow_run_id: i64,
    pub run_attempt: i64,
    pub job_id: i64,
    pub job_name: String,
    pub runner_os: Option<String>,
    pub failed_step: Option<String>,
    pub conclusion: String,
    pub exit_code: Option<i32>,
    pub error_excerpt: String,
    pub changed_files: Vec<String>,
    pub suspected_files: Vec<String>,
    pub classification: String,
}

impl CiFailureReport {
    pub fn new(
        repository: String,
        pr_number: i64,
        head_sha: String,
        workflow_run_id: i64,
        run_attempt: i64,
        job_id: i64,
        job_name: String,
        conclusion: String,
        logs: &str,
    ) -> Self {
        let error_excerpt = extract_error_excerpt(logs, 4000);
        let exit_code = extract_exit_code(logs);
        let classification = classify(&job_name, &error_excerpt);

        Self {
            schema_version: 1,
            repository,
            pr_number,
            head_sha,
            workflow_run_id,
            run_attempt,
            job_id,
            job_name,
            runner_os: None,
            failed_step: None,
            conclusion,
            exit_code,
            error_excerpt,
            changed_files: Vec::new(),
            suspected_files: Vec::new(),
            classification,
        }
    }
}

fn classify(job_name: &str, log: &str) -> String {
    let combined = format!("{} {}", job_name, log).to_lowercase();

    if combined.contains("lint") || combined.contains("oxlint") || combined.contains("eslint") {
        return "lint".to_string();
    }
    if combined.contains("typecheck") || combined.contains("tsc") || combined.contains("typescript")
    {
        return "typecheck".to_string();
    }
    if combined.contains("build") && (combined.contains("error") || combined.contains("failed")) {
        return "build".to_string();
    }
    if combined.contains("test") && (combined.contains("fail") || combined.contains("assert")) {
        return "test".to_string();
    }
    if combined.contains("pack") || combined.contains("tarball") {
        return "packaging".to_string();
    }
    if combined.contains("migrat") {
        return "migration".to_string();
    }
    if combined.contains("rust") || combined.contains("cargo") || combined.contains("clippy") {
        return "platform".to_string();
    }
    if combined.contains("timeout") || combined.contains("network") || combined.contains("time out")
    {
        return "infrastructure".to_string();
    }

    "unknown".to_string()
}
