//! Constraint checks for PR Monitor operations.
//! Verifies permissions, repo ownership, and head SHA validity.

pub struct PrMonitorChecks;

impl PrMonitorChecks {
    /// A fork PR can only be repaired when the monitor runs in the same repo.
    pub fn can_repair_fork_pr(is_fork: bool, same_repo_only: bool) -> bool {
        !is_fork || !same_repo_only
    }

    /// The head SHA must match the most recent commit on the PR branch.
    pub fn is_head_current(pr_head_sha: &str, actual_head_sha: &str) -> bool {
        pr_head_sha == actual_head_sha
    }

    /// Paths that the monitor must never modify.
    pub fn is_prohibited_path(path: &str, prohibited: &[&str]) -> bool {
        prohibited.iter().any(|p| path.starts_with(p) || path == *p)
    }
}
