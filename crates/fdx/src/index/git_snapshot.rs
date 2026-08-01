//! Git snapshot for tracking repository state

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

/// Git file status
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Ignored,
    Conflicted,
}

/// A changed file entry
#[derive(Debug, Clone)]
pub struct ChangedFile {
    pub path: PathBuf,
    pub status: FileStatus,
    pub old_path: Option<PathBuf>,
}

/// Git snapshot at a point in time
#[derive(Debug, Clone)]
pub struct GitSnapshot {
    /// Head commit SHA
    pub head: String,
    /// Branch name
    pub branch: String,
    /// Changed files in working tree
    pub changed_files: Vec<ChangedFile>,
    /// Timestamp of snapshot
    pub timestamp: SystemTime,
    /// Is repository clean
    pub is_clean: bool,
}

impl GitSnapshot {
    /// Create a new snapshot by running git commands
    pub fn capture(repo_path: &Path) -> anyhow::Result<Self> {
        let head = Self::git_rev_parse(repo_path)?;
        let branch = Self::git_branch(repo_path)?;
        let changed_files = Self::git_status(repo_path)?;
        let is_clean = changed_files.is_empty();

        Ok(Self {
            head,
            branch,
            changed_files,
            timestamp: SystemTime::now(),
            is_clean,
        })
    }

    fn git_rev_parse(repo_path: &Path) -> anyhow::Result<String> {
        let output = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(repo_path)
            .output()?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Ok("unknown".to_string())
        }
    }

    fn git_branch(repo_path: &Path) -> anyhow::Result<String> {
        let output = Command::new("git")
            .args(["branch", "--show-current"])
            .current_dir(repo_path)
            .output()?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Ok("unknown".to_string())
        }
    }

    fn git_status(repo_path: &Path) -> anyhow::Result<Vec<ChangedFile>> {
        let output = Command::new("git")
            .args(["status", "--porcelain", "-uall"])
            .current_dir(repo_path)
            .output()?;

        if !output.status.success() {
            return Ok(Vec::new());
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let mut changed_files = Vec::new();

        for line in stdout.lines() {
            if line.len() < 3 {
                continue;
            }

            let status_chars = &line[..2];
            let path_str = line[3..].trim();

            // Handle renamed files
            let (path, old_path) = if path_str.contains(" -> ") {
                let parts: Vec<&str> = path_str.split(" -> ").collect();
                (
                    PathBuf::from(parts[1]),
                    Some(PathBuf::from(parts[0])),
                )
            } else {
                (PathBuf::from(path_str), None)
            };

            let status = match status_chars {
                "A " | "??" => FileStatus::Added,
                "M " | "MM" => FileStatus::Modified,
                "D " => FileStatus::Deleted,
                "R " | "RM" | "RC" => FileStatus::Renamed,
                "! " => FileStatus::Ignored,
                "U " | "AA" | "DD" | "AU" | "UA" | "DU" | "UD" => FileStatus::Conflicted,
                _ => FileStatus::Untracked,
            };

            changed_files.push(ChangedFile {
                path,
                status,
                old_path,
            });
        }

        Ok(changed_files)
    }

    /// Check if a file has changed since this snapshot
    pub fn file_changed_since(&self, path: &Path, previous: &GitSnapshot) -> bool {
        // Check if HEAD changed
        if self.head != previous.head {
            return true;
        }

        // Check if file is in changed list
        self.changed_files
            .iter()
            .any(|cf| cf.path == path)
    }

    /// Get added files
    pub fn added_files(&self) -> Vec<PathBuf> {
        self.changed_files
            .iter()
            .filter(|cf| cf.status == FileStatus::Added)
            .map(|cf| cf.path.clone())
            .collect()
    }

    /// Get modified files
    pub fn modified_files(&self) -> Vec<PathBuf> {
        self.changed_files
            .iter()
            .filter(|cf| cf.status == FileStatus::Modified)
            .map(|cf| cf.path.clone())
            .collect()
    }

    /// Get deleted files
    pub fn deleted_files(&self) -> Vec<PathBuf> {
        self.changed_files
            .iter()
            .filter(|cf| cf.status == FileStatus::Deleted)
            .map(|cf| cf.path.clone())
            .collect()
    }
}

/// Git snapshot manager
#[derive(Debug, Clone)]
pub struct GitSnapshotManager {
    /// Current snapshot
    current: Arc<RwLock<Option<GitSnapshot>>>,
    /// Snapshot history
    history: Arc<RwLock<Vec<GitSnapshot>>>,
}

impl GitSnapshotManager {
    pub fn new() -> Self {
        Self {
            current: Arc::new(RwLock::new(None)),
            history: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Capture a new snapshot
    pub fn capture(&self, repo_path: &Path) -> anyhow::Result<()> {
        let snapshot = GitSnapshot::capture(repo_path)?;

        // Store in history
        {
            let mut history = self.history.write().unwrap();
            history.push(snapshot.clone());
        }

        // Update current
        {
            let mut current = self.current.write().unwrap();
            *current = Some(snapshot);
        }

        Ok(())
    }

    /// Get current snapshot
    pub fn current(&self) -> Option<GitSnapshot> {
        let current = self.current.read().unwrap();
        current.clone()
    }

    /// Get snapshot history
    pub fn history(&self) -> Vec<GitSnapshot> {
        let history = self.history.read().unwrap();
        history.clone()
    }

    /// Get files changed since previous snapshot
    pub fn changed_since_previous(&self) -> Vec<PathBuf> {
        let history = self.history.read().unwrap();
        if history.len() < 2 {
            return Vec::new();
        }

        let current = &history[history.len() - 1];
        let previous = &history[history.len() - 2];

        current
            .changed_files
            .iter()
            .filter(|cf| {
                !previous
                    .changed_files
                    .iter()
                    .any(|pcf| pcf.path == cf.path && pcf.status == cf.status)
            })
            .map(|cf| cf.path.clone())
            .collect()
    }

    /// Clear history
    pub fn clear_history(&self) {
        let mut history = self.history.write().unwrap();
        history.clear();
    }
}

impl Default for GitSnapshotManager {
    fn default() -> Self {
        Self::new()
    }
}
