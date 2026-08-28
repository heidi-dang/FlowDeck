//! Typed executable verification actions.
//!
//! Converts abstract planned checks into strictly bounded, argument-safe executable commands.
//! Never executes arbitrary planner display strings or user shell templates.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Validated individual JS/TS test capability with exact runner and fixed argument semantics.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum IndividualTestCapability {
    Vitest { fixed_args: Vec<String> },
    Jest { fixed_args: Vec<String> },
}

impl IndividualTestCapability {
    pub fn runner_name(&self) -> &str {
        match self {
            Self::Vitest { .. } => "vitest",
            Self::Jest { .. } => "jest",
        }
    }
}

/// Strongly-typed verification action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionAction {
    /// Execute an npm/pnpm/yarn/bun package script in a package directory.
    NpmRunScript {
        pkg_dir: PathBuf,
        script_name: String,
        package_manager: String,
    },
    /// Execute a specific test file via a positively validated runner capability.
    NpmRunTestFile {
        pkg_dir: PathBuf,
        test_file_rel: String,
        package_manager: String,
        capability: IndividualTestCapability,
    },
    /// Execute Cargo package tests.
    CargoTestPackage {
        pkg_dir: PathBuf,
        package_name: Option<String>,
    },
    /// Execute a specific Cargo integration test target.
    CargoTestTarget {
        pkg_dir: PathBuf,
        package_name: Option<String>,
        test_target: String,
    },
    /// Execute Cargo check on a package.
    CargoCheckPackage {
        pkg_dir: PathBuf,
        package_name: Option<String>,
    },
    /// Execute Cargo clippy on a package.
    CargoClippyPackage {
        pkg_dir: PathBuf,
        package_name: Option<String>,
    },
    /// Execute Cargo build on a package.
    CargoBuildPackage {
        pkg_dir: PathBuf,
        package_name: Option<String>,
    },
    /// Unsupported or unexecutable check kind.
    Unsupported { check_id: String, reason: String },
}

/// Resolved concrete execution invocation.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ConcreteInvocation {
    pub program: String,
    pub argv: Vec<String>,
    pub cwd: PathBuf,
}

impl ExecutionAction {
    /// Convert a typed execution action into a safe argument vector and execution directory.
    pub fn to_invocation(&self, repo_root: &Path) -> Result<ConcreteInvocation, String> {
        match self {
            Self::NpmRunScript {
                pkg_dir,
                script_name,
                package_manager,
            } => {
                let cwd = if pkg_dir.as_os_str().is_empty() || pkg_dir == Path::new(".") {
                    repo_root.to_path_buf()
                } else if pkg_dir.is_absolute() {
                    pkg_dir.clone()
                } else {
                    repo_root.join(pkg_dir)
                };

                let argv = vec!["run".to_string(), script_name.clone()];
                Ok(ConcreteInvocation {
                    program: package_manager.clone(),
                    argv,
                    cwd,
                })
            }
            Self::NpmRunTestFile {
                pkg_dir,
                test_file_rel,
                package_manager,
                capability: _capability,
            } => {
                let cwd = if pkg_dir.as_os_str().is_empty() || pkg_dir == Path::new(".") {
                    repo_root.to_path_buf()
                } else if pkg_dir.is_absolute() {
                    pkg_dir.clone()
                } else {
                    repo_root.join(pkg_dir)
                };

                // Manager-specific argument forwarding for proven test script
                let argv = match package_manager.as_str() {
                    "yarn" => vec![
                        "run".to_string(),
                        "test".to_string(),
                        "--".to_string(),
                        test_file_rel.clone(),
                    ],
                    "pnpm" => vec![
                        "run".to_string(),
                        "test".to_string(),
                        "--".to_string(),
                        test_file_rel.clone(),
                    ],
                    "bun" => vec![
                        "run".to_string(),
                        "test".to_string(),
                        "--".to_string(),
                        test_file_rel.clone(),
                    ],
                    _ => vec![
                        "run".to_string(),
                        "test".to_string(),
                        "--".to_string(),
                        test_file_rel.clone(),
                    ],
                };

                Ok(ConcreteInvocation {
                    program: package_manager.clone(),
                    argv,
                    cwd,
                })
            }
            Self::CargoTestPackage {
                pkg_dir,
                package_name,
            } => {
                let cwd = if pkg_dir.as_os_str().is_empty() || pkg_dir == Path::new(".") {
                    repo_root.to_path_buf()
                } else if pkg_dir.is_absolute() {
                    pkg_dir.clone()
                } else {
                    repo_root.join(pkg_dir)
                };

                let mut argv = vec!["test".to_string()];
                if let Some(pkg) = package_name {
                    argv.push("-p".to_string());
                    argv.push(pkg.clone());
                }
                Ok(ConcreteInvocation {
                    program: "cargo".to_string(),
                    argv,
                    cwd,
                })
            }
            Self::CargoTestTarget {
                pkg_dir,
                package_name,
                test_target,
            } => {
                let cwd = if pkg_dir.as_os_str().is_empty() || pkg_dir == Path::new(".") {
                    repo_root.to_path_buf()
                } else if pkg_dir.is_absolute() {
                    pkg_dir.clone()
                } else {
                    repo_root.join(pkg_dir)
                };

                let mut argv = vec!["test".to_string()];
                if let Some(pkg) = package_name {
                    argv.push("-p".to_string());
                    argv.push(pkg.clone());
                }
                argv.push("--test".to_string());
                argv.push(test_target.clone());
                Ok(ConcreteInvocation {
                    program: "cargo".to_string(),
                    argv,
                    cwd,
                })
            }
            Self::CargoCheckPackage {
                pkg_dir,
                package_name,
            } => {
                let cwd = if pkg_dir.as_os_str().is_empty() || pkg_dir == Path::new(".") {
                    repo_root.to_path_buf()
                } else if pkg_dir.is_absolute() {
                    pkg_dir.clone()
                } else {
                    repo_root.join(pkg_dir)
                };

                let mut argv = vec!["check".to_string()];
                if let Some(pkg) = package_name {
                    argv.push("-p".to_string());
                    argv.push(pkg.clone());
                }
                Ok(ConcreteInvocation {
                    program: "cargo".to_string(),
                    argv,
                    cwd,
                })
            }
            Self::CargoClippyPackage {
                pkg_dir,
                package_name,
            } => {
                let cwd = if pkg_dir.as_os_str().is_empty() || pkg_dir == Path::new(".") {
                    repo_root.to_path_buf()
                } else if pkg_dir.is_absolute() {
                    pkg_dir.clone()
                } else {
                    repo_root.join(pkg_dir)
                };

                let mut argv = vec!["clippy".to_string()];
                if let Some(pkg) = package_name {
                    argv.push("-p".to_string());
                    argv.push(pkg.clone());
                }
                Ok(ConcreteInvocation {
                    program: "cargo".to_string(),
                    argv,
                    cwd,
                })
            }
            Self::CargoBuildPackage {
                pkg_dir,
                package_name,
            } => {
                let cwd = if pkg_dir.as_os_str().is_empty() || pkg_dir == Path::new(".") {
                    repo_root.to_path_buf()
                } else if pkg_dir.is_absolute() {
                    pkg_dir.clone()
                } else {
                    repo_root.join(pkg_dir)
                };

                let mut argv = vec!["build".to_string()];
                if let Some(pkg) = package_name {
                    argv.push("-p".to_string());
                    argv.push(pkg.clone());
                }
                Ok(ConcreteInvocation {
                    program: "cargo".to_string(),
                    argv,
                    cwd,
                })
            }
            Self::Unsupported { reason, .. } => Err(reason.clone()),
        }
    }
}
