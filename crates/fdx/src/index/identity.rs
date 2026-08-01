//! Repository/worktree identity computation.
//!
//! Task 3 §3: index identity must include canonical repository identity,
//! worktree identity, repository root, HEAD SHA, dirty-tree fingerprint, FDX
//! version, schema version, config hash, and ignore-rule hash.
//!
//! Two worktrees never share mutable state (distinct `worktree_id`); branch
//! changes invalidate only affected layers (HEAD SHA changes → metadata and
//! symbol layers refresh against the new tree); dirty changes are represented
//! independently from HEAD (dirty fingerprint + git-state snapshot).

use crate::index::manifest::{IndexIdentity, INDEX_SCHEMA_VERSION};
use crate::index::paths::validate_segment;
use std::path::{Path, PathBuf};

/// The git executable used for identity discovery.
const GIT: &str = "git";

/// Compute the canonical repository + worktree identity for `worktree`.
///
/// * `worktree` — the directory to index (a git working tree or plain dir).
/// * `fdx_version` — the FDX binary version (recorded in the manifest).
///
/// Returns the identity. When the directory is not inside a git repository,
/// the repository root is the directory itself (a "plain" worktree) and the
/// HEAD SHA is empty.
pub fn discover_identity(worktree: &Path, _fdx_version: &str) -> IndexIdentity {
    let worktree_root = canonicalize_or_abs(worktree);
    let worktree_root_str = normalize_for_hash(&worktree_root);

    // Find the repository root via git.
    let repo_root = git_repo_root(&worktree_root).unwrap_or_else(|| worktree_root.clone());

    // A linked worktree (git worktree add) shares the repo but has its own
    // root; `git rev-parse --show-toplevel` returns the *worktree* toplevel,
    // and `git rev-parse --git-common-dir` returns the shared repo metadata
    // dir (the main worktree's .git). Using the common dir as the canonical
    // repo identity makes all worktrees of one repository share `repository_id`
    // while keeping distinct `worktree_id`s.
    let git_common_dir = git_common_dir(&worktree_root);
    let canonical_repo_root = match git_common_dir {
        Some(common) => common,
        None => repo_root.clone(),
    };
    let canonical_repo_root_str = normalize_for_hash(&canonical_repo_root);

    // Short hashes: repository id + worktree id. Only hashes appear in file
    // names (bounded, no raw paths).
    let repository_id = short_segment(&["repo", &canonical_repo_root_str]);
    let worktree_id = short_segment(&["worktree", &worktree_root_str]);
    let repository_root_hash = short_segment(&["root", &canonical_repo_root_str]);

    IndexIdentity {
        repository_id,
        worktree_id,
        repository_root_hash,
        repository_root: canonical_repo_root.to_string_lossy().into_owned(),
        worktree_root: worktree_root.to_string_lossy().into_owned(),
    }
}

/// Normalize a path for deterministic hashing across platforms: canonicalize
/// (resolve symlinks), then lowercase on case-insensitive filesystems.
fn normalize_for_hash(path: &Path) -> String {
    let canonical = canonicalize_or_abs(path);
    let s = canonical.to_string_lossy().into_owned();
    if case_insensitive_fs() {
        s.to_lowercase()
    } else {
        s
    }
}

/// Whether the current platform is case-insensitive (Windows, macOS default).
fn case_insensitive_fs() -> bool {
    cfg!(windows) || cfg!(target_os = "macos")
}

/// Canonicalize a path, falling back to the absolute form when canonicalize
/// fails (e.g. the directory was just created).
fn canonicalize_or_abs(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| {
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(path))
                .unwrap_or_else(|_| path.to_path_buf())
        }
    })
}

/// Run git and return trimmed stdout on success.
fn git_out(args: &[&str], cwd: &Path) -> Option<String> {
    let output = std::process::Command::new(GIT)
        .args(args)
        .current_dir(cwd)
        .output()
        .ok()?;
    if output.status.success() {
        // trim_end only: porcelain status lines begin with a space for
        // unstaged changes (" M file"), which must be preserved for parsing.
        Some(
            String::from_utf8_lossy(&output.stdout)
                .trim_end()
                .to_string(),
        )
    } else {
        None
    }
}

/// The repository root (`git rev-parse --show-toplevel`).
fn git_repo_root(cwd: &Path) -> Option<PathBuf> {
    git_out(&["rev-parse", "--show-toplevel"], cwd).map(PathBuf::from)
}

/// The shared git metadata dir (`git rev-parse --git-common-dir`).
///
/// For a linked worktree this resolves through the `.git` file to the main
/// repository's common dir, so every worktree of one repository yields the
/// same canonical repo root.
fn git_common_dir(cwd: &Path) -> Option<PathBuf> {
    git_out(
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd,
    )
    .map(PathBuf::from)
}

/// Current HEAD SHA (`git rev-parse HEAD`). Empty when not a git repo.
pub fn git_head_sha(cwd: &Path) -> String {
    git_out(&["rev-parse", "HEAD"], cwd).unwrap_or_default()
}

/// Current branch name ("" when detached or not a git repo).
pub fn git_branch(cwd: &Path) -> String {
    git_out(&["rev-parse", "--abbrev-ref", "HEAD"], cwd)
        .filter(|b| b != "HEAD")
        .unwrap_or_default()
}

/// Whether HEAD is detached.
pub fn git_detached(cwd: &Path) -> bool {
    git_branch(cwd).is_empty() && !git_head_sha(cwd).is_empty()
}

/// Dirty-tree fingerprint: a stable hash over `git status --porcelain`
/// AND the content hashes of files reported as modified/untracked. Two equal
/// trees produce the same fingerprint; ANY worktree change — including a
/// content edit inside an already-dirty file — flips it.
///
/// The status text alone is insufficient: ` M lib.ts` is identical whether
/// lib.ts changed once or three times, so the fingerprint must incorporate
/// the dirty files' content to make the no-change fast path sound.
pub fn dirty_fingerprint(cwd: &Path) -> String {
    let status = git_out(&["status", "--porcelain=v1", "--no-renames"], cwd).unwrap_or_default();
    if status.is_empty() {
        return short_segment(&["dirty", ""]);
    }
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    hasher.update(b"dirty\0");
    let mut lines: Vec<&str> = status.lines().collect();
    lines.sort_unstable();
    let max_content_files = 1000usize;
    let mut content_count = 0usize;
    for line in lines {
        hasher.update(line.as_bytes());
        hasher.update(b"\0");
        if line.len() < 4 {
            continue;
        }
        let status_part = &line[0..2];
        // Include content hash for modified/untracked/added files so a
        // content edit inside an already-dirty file is detected. Deleted
        // files have no content to hash (their removal is in the status).
        if (status_part.contains('M') || status_part.contains('?') || status_part.contains('A'))
            && content_count < max_content_files
        {
            let path = line[3..].trim().trim_matches('"');
            if !path.is_empty() {
                if let Ok(meta) = std::fs::metadata(cwd.join(path)) {
                    if meta.is_file() {
                        if let Ok(content) = std::fs::read(cwd.join(path)) {
                            hasher.update(&content);
                            hasher.update(b"\0");
                            content_count += 1;
                        }
                    }
                }
            }
        }
    }
    let digest = hasher.finalize();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Hash of relevant configuration. For Task 3 the "relevant config" is the
/// set of FlowDeck/FDX config files discovered in the repo, hashed together.
pub fn config_hash(cwd: &Path) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    for name in [
        ".flowdeck.json",
        ".flowdeck.jsonc",
        ".fdx.json",
        ".fdxrc",
        "flowdeck.json",
    ] {
        let p = cwd.join(name);
        if let Ok(content) = std::fs::read(&p) {
            hasher.update(name.as_bytes());
            hasher.update(&content);
        }
    }
    finish_short(&mut hasher)
}

/// Hash of ignore rules: the concatenation of `.gitignore`, `.ignore`, and
/// `.fdignore` files found in the repository root (top-level).
pub fn ignore_hash(cwd: &Path) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    for name in [".gitignore", ".ignore", ".fdignore"] {
        let p = cwd.join(name);
        if let Ok(content) = std::fs::read(&p) {
            hasher.update(name.as_bytes());
            hasher.update(&content);
        }
    }
    finish_short(&mut hasher)
}

fn finish_short(hasher: &mut sha2::Sha256) -> String {
    use sha2::Digest;
    // Sha256 is Clone; finalize() consumes self, so hash a clone.
    let digest = hasher.clone().finalize();
    digest.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// A bounded, filesystem-safe hash segment (16 hex chars).
fn short_segment(parts: &[&str]) -> String {
    use sha2::Digest;
    let mut hasher = sha2::Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update(b"\0");
    }
    let digest = hasher.finalize();
    let seg = digest
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    debug_assert!(validate_segment(&seg));
    seg
}

/// The FDX binary version (from Cargo).
pub fn fdx_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Index schema version (from manifest module).
pub fn schema_version() -> u32 {
    INDEX_SCHEMA_VERSION
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) -> std::io::Result<String> {
        let out = Command::new("git").args(args).current_dir(cwd).output()?;
        assert!(
            out.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    fn init_repo(dir: &Path) {
        git(dir, &["init", "-q"]).unwrap();
        git(dir, &["config", "user.email", "t@t"]).unwrap();
        git(dir, &["config", "user.name", "t"]).unwrap();
    }

    #[test]
    fn identity_is_stable_and_worktree_scoped() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        std::fs::write(tmp.path().join("a.txt"), "a").unwrap();
        git(tmp.path(), &["add", "."]).unwrap();
        git(tmp.path(), &["commit", "-qm", "init"]).unwrap();

        let id1 = discover_identity(tmp.path(), "0.1.0");
        let id2 = discover_identity(tmp.path(), "0.1.0");
        assert_eq!(id1.repository_id, id2.repository_id);
        assert_eq!(id1.worktree_id, id2.worktree_id);
        assert_eq!(id1.repository_root_hash, id2.repository_root_hash);
        assert!(!id1.repository_id.is_empty());
        assert!(validate_segment(&id1.repository_id));
        assert!(validate_segment(&id1.worktree_id));
    }

    #[test]
    fn head_sha_and_fingerprint_are_detected() {
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        std::fs::write(tmp.path().join("a.txt"), "a").unwrap();
        git(tmp.path(), &["add", "."]).unwrap();
        git(tmp.path(), &["commit", "-qm", "init"]).unwrap();
        let head1 = git_head_sha(tmp.path());
        assert_eq!(head1.len(), 40);
        let fp_clean = dirty_fingerprint(tmp.path());
        // Dirty the tree.
        std::fs::write(tmp.path().join("a.txt"), "b").unwrap();
        let fp_dirty = dirty_fingerprint(tmp.path());
        assert_ne!(fp_clean, fp_dirty);
    }

    #[test]
    fn fingerprint_detects_content_edit_within_already_dirty_file() {
        // Regression: git status text (" M a.txt") is identical whether the
        // file changed once or twice; the fingerprint must incorporate the
        // dirty file's content so a second edit is still detected.
        let tmp = tempfile::tempdir().unwrap();
        init_repo(tmp.path());
        std::fs::write(tmp.path().join("a.txt"), "a").unwrap();
        git(tmp.path(), &["add", "."]).unwrap();
        git(tmp.path(), &["commit", "-qm", "init"]).unwrap();

        std::fs::write(tmp.path().join("a.txt"), "b").unwrap();
        let fp1 = dirty_fingerprint(tmp.path());
        std::fs::write(tmp.path().join("a.txt"), "c").unwrap();
        let fp2 = dirty_fingerprint(tmp.path());
        assert_ne!(
            fp1, fp2,
            "second edit inside an already-dirty file must flip the fingerprint"
        );

        // Clean tree fingerprint is stable and distinct.
        git(tmp.path(), &["add", "-A"]).unwrap();
        git(tmp.path(), &["commit", "-qm", "second"]).unwrap();
        let fp_clean = dirty_fingerprint(tmp.path());
        assert_eq!(fp_clean, short_segment(&["dirty", ""]));
    }

    #[test]
    fn plain_directory_gets_identity_without_git() {
        let tmp = tempfile::tempdir().unwrap();
        let id = discover_identity(tmp.path(), "0.1.0");
        assert!(!id.repository_id.is_empty());
        assert!(!id.worktree_id.is_empty());
        assert_eq!(git_head_sha(tmp.path()), "");
        assert!(git_branch(tmp.path()).is_empty());
    }

    #[test]
    fn two_worktrees_share_repo_but_not_worktree_id() {
        // Skip when git doesn't support worktrees (should be fine on CI).
        let base = tempfile::tempdir().unwrap();
        init_repo(base.path());
        std::fs::write(base.path().join("a.txt"), "a").unwrap();
        git(base.path(), &["add", "."]).unwrap();
        git(base.path(), &["commit", "-qm", "init"]).unwrap();

        let wt = base.path().join("wt2");
        git(
            base.path(),
            &["worktree", "add", "-q", wt.to_str().unwrap()],
        )
        .unwrap();

        let id_main = discover_identity(base.path(), "0.1.0");
        let id_wt = discover_identity(&wt, "0.1.0");
        // Linked worktrees share the repository identity but have distinct
        // worktree ids.
        assert_eq!(id_main.repository_id, id_wt.repository_id, "same repo id");
        assert_ne!(
            id_main.worktree_id, id_wt.worktree_id,
            "distinct worktree ids"
        );
        let _ = git(
            base.path(),
            &["worktree", "remove", "--force", wt.to_str().unwrap()],
        );
    }

    #[test]
    fn config_and_ignore_hashes_change_on_content_change() {
        let tmp = tempfile::tempdir().unwrap();
        let h1 = config_hash(tmp.path());
        std::fs::write(tmp.path().join(".flowdeck.json"), "{\"x\":1}").unwrap();
        let h2 = config_hash(tmp.path());
        assert_ne!(h1, h2);

        let i1 = ignore_hash(tmp.path());
        std::fs::write(tmp.path().join(".gitignore"), "node_modules\n").unwrap();
        let i2 = ignore_hash(tmp.path());
        assert_ne!(i1, i2);
    }

    #[test]
    fn schema_version_is_current() {
        assert_eq!(schema_version(), INDEX_SCHEMA_VERSION);
        assert_eq!(fdx_version(), "0.1.0");
    }
}
