
use std::path::Path;
use std::process::Command;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepositorySnapshot {
    pub head: Option<String>,
    pub dirty_fingerprint: String,
}

pub fn get_repository_snapshot(repo_root: &Path) -> Result<RepositorySnapshot, &'static str> {
    let head = Command::new("git")
        .arg("rev-parse")
        .arg("HEAD")
        .current_dir(repo_root)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                String::from_utf8(o.stdout).ok().map(|s| s.trim().to_string())
            } else {
                None
            }
        });

    let status_output = Command::new("git")
        .arg("status")
        .arg("-z")
        .arg("--porcelain")
        .current_dir(repo_root)
        .output();

    let mut hasher = Sha256::new();

    match status_output {
        Ok(o) if o.status.success() => {
            let mut i = 0;
            while i < o.stdout.len() {
                if i + 2 >= o.stdout.len() {
                    break;
                }
                let xy = &o.stdout[i..i + 2];
                i += 3; // skip XY and space

                let start = i;
                while i < o.stdout.len() && o.stdout[i] != 0 {
                    i += 1;
                }
                let path_bytes = &o.stdout[start..i];
                i += 1; // skip \0

                // If rename, there's another path
                if xy[0] == b'R' || xy[0] == b'C' {
                    let _orig_start = i;
                    while i < o.stdout.len() && o.stdout[i] != 0 {
                        i += 1;
                    }
                    i += 1;
                }

                // Exclude .fdx/
                if path_bytes.starts_with(b".fdx/") {
                    continue;
                }

                hasher.update(xy);
                hasher.update(b"|");
                hasher.update(path_bytes);
                hasher.update(b"|");

                // If it's not a deletion, hash the content
                if xy[1] != b'D' && xy[0] != b'D' {
                    if let Ok(path_str) = std::str::from_utf8(path_bytes) {
                        let full_path = repo_root.join(path_str);
                        if let Ok(metadata) = std::fs::metadata(&full_path) {
                            if metadata.is_file() {
                                let size = metadata.len();
                                if size <= 10 * 1024 * 1024 {
                                    if let Ok(mut file) = std::fs::File::open(&full_path) {
                                        let _ = std::io::copy(&mut file, &mut hasher);
                                    }
                                } else {
                                    hasher.update(b"TOO_LARGE");
                                    hasher.update(size.to_le_bytes());
                                }
                            }
                        }
                    }
                }
            }
        }
        _ => return Err("repository_snapshot_unavailable"),
    }

    let dirty = format!("{:x}", hasher.finalize());

    Ok(RepositorySnapshot {
        head,
        dirty_fingerprint: dirty,
    })
}