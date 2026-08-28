use sha2::{Digest, Sha256};
use std::path::Path;
use std::process::Command;

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
                String::from_utf8(o.stdout)
                    .ok()
                    .map(|s| s.trim().to_string())
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

                // First NUL-delimited path (the new/current path for renames/copies)
                let start = i;
                while i < o.stdout.len() && o.stdout[i] != 0 {
                    i += 1;
                }
                let path1 = &o.stdout[start..i];
                i += 1;

                // Rename/copy records carry a second NUL-delimited path (the
                // source/original path). It MUST be part of the snapshot identity
                // so "a.ts -> b.ts" and "c.ts -> b.ts" never collide.
                let mut path2: Option<&[u8]> = None;
                if (xy[0] == b'R' || xy[0] == b'C') && i < o.stdout.len() {
                    let start2 = i;
                    while i < o.stdout.len() && o.stdout[i] != 0 {
                        i += 1;
                    }
                    path2 = Some(&o.stdout[start2..i]);
                    i += 1;
                }

                // Exclude .fdx/ from snapshot identity.
                if path1.starts_with(b".fdx/") {
                    continue;
                }

                hasher.update(xy);
                hasher.update(b"|");
                hasher.update(path1);
                hasher.update(b"|");
                if let Some(p2) = path2 {
                    hasher.update(p2);
                    hasher.update(b"|");
                }

                // If it's not a deletion, hash the current (destination) content
                if xy[1] != b'D' && xy[0] != b'D' {
                    if let Ok(path_str) = std::str::from_utf8(path1) {
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
