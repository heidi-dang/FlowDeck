use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositorySnapshot {
    pub head: Option<String>,
    pub dirty_fingerprint: String,
}

pub fn get_repository_snapshot(repo_root: &Path) -> RepositorySnapshot {
    let head = Command::new("git")
        .arg("rev-parse")
        .arg("HEAD")
        .current_dir(repo_root)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout)
                    .ok()
                    .map(|s| s.trim().to_string())
            } else {
                None
            }
        });

    let dirty = Command::new("git")
        .arg("status")
        .arg("--porcelain")
        .current_dir(repo_root)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                let out = o.stdout;
                // Quick hashing of the status output to get a fingerprint
                use sha2::{Digest, Sha256};
                let mut hasher = Sha256::new();
                hasher.update(&out);
                Some(format!("{:x}", hasher.finalize()))
            } else {
                None
            }
        })
        .unwrap_or_else(|| "unknown".to_string());

    RepositorySnapshot {
        head,
        dirty_fingerprint: dirty,
    }
}
