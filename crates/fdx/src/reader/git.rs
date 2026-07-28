use crate::runner::{run, CommandOutput};
use anyhow::Result;

pub const GIT_READONLY_SUBCOMMANDS: &[&str] = &[
    "status",
    "log",
    "diff",
    "show",
    "blame",
    "ls-files",
    "ls-tree",
    "rev-parse",
    "rev-list",
    "describe",
    "shortlog",
    "branch",
    "tag",
    "stash",
];

/// Arguments that spawn external programs or mutate state — always rejected.
const REJECTED_ARG_PREFIXES: &[&str] = &[
    "--output",
    "--ext-diff",
    "--textconv",
    "--exec-path",
    "--paginate",
    "--no-pager",
    "--pager",
    "-c",
];

pub fn validate_git_policy(subcommand: &str, args: &[&str]) -> Result<()> {
    let sub = subcommand.trim();
    if sub.is_empty() || !GIT_READONLY_SUBCOMMANDS.contains(&sub) {
        anyhow::bail!(
            "[FDX Git Policy] Subcommand \"{}\" is not permitted under read-only policy. Allowed: {}",
            sub,
            GIT_READONLY_SUBCOMMANDS.join(", ")
        );
    }

    // Reject any argument that could trigger mutations or external execution
    for arg in args {
        let trimmed = arg.trim();
        for prefix in REJECTED_ARG_PREFIXES {
            if trimmed == *prefix || trimmed.starts_with(&format!("{}=", prefix)) {
                anyhow::bail!(
                    "[FDX Git Policy] Argument \"{}\" is prohibited under read-only policy.",
                    trimmed
                );
            }
        }
        // Reject pager/editor config overrides passed as git -c key=value
        if trimmed.starts_with("-c ") || trimmed.starts_with("-c=") {
            let val = trimmed.trim_start_matches("-c ").trim_start_matches("-c=");
            if val.contains("pager")
                || val.contains("editor")
                || val.contains("interactive")
                || val.contains("alias")
                || val.contains("diff.external")
            {
                anyhow::bail!(
                    "[FDX Git Policy] Config override \"{}\" could spawn external commands.",
                    trimmed
                );
            }
        }
    }

    if sub == "branch" {
        for arg in args {
            let a = *arg;
            if a.starts_with("-d")
                || a.starts_with("-D")
                || a.starts_with("-m")
                || a.starts_with("-M")
                || a.starts_with("-c")
                || a.starts_with("-C")
                || a.starts_with("--delete")
                || a.starts_with("--move")
                || a.starts_with("--copy")
                || a.starts_with("--edit-description")
            {
                anyhow::bail!("[FDX Git Policy] Mutating branch flag \"{}\" is prohibited under read-only policy.", arg);
            }
        }
        let has_list_flag = args.iter().any(|a| {
            matches!(
                *a,
                "--list" | "-l" | "--show-current" | "-a" | "-r" | "--all" | "--remotes"
            ) || a.starts_with("--format")
        });
        let positional: Vec<&&str> = args.iter().filter(|a| !a.starts_with('-')).collect();
        if !positional.is_empty() && !has_list_flag {
            anyhow::bail!(
                "[FDX Git Policy] Prohibited branch modification attempt with argument \"{}\".",
                positional[0]
            );
        }
    }

    if sub == "tag" {
        for arg in args {
            let a = *arg;
            if a.starts_with("-d")
                || a.starts_with("-D")
                || a.starts_with("-a")
                || a.starts_with("-s")
                || a.starts_with("-f")
                || a.starts_with("--delete")
                || a.starts_with("--annotate")
                || a.starts_with("--sign")
                || a.starts_with("--force")
            {
                anyhow::bail!("[FDX Git Policy] Mutating tag flag \"{}\" is prohibited under read-only policy.", arg);
            }
        }
        let has_list_flag = args
            .iter()
            .any(|a| matches!(*a, "-l" | "--list") || a.starts_with("--format"));
        let positional: Vec<&&str> = args.iter().filter(|a| !a.starts_with('-')).collect();
        if !positional.is_empty() && !has_list_flag {
            anyhow::bail!(
                "[FDX Git Policy] Prohibited tag modification attempt with argument \"{}\".",
                positional[0]
            );
        }
    }


    if sub == "stash" {
        let stash_sub = args.first().copied().unwrap_or("").trim();
        if stash_sub != "list" && stash_sub != "show" {
            anyhow::bail!(
                "[FDX Git Policy] Stash operation \"{}\" is prohibited. Only \"stash list\" and \"stash show\" are allowed under read-only policy.",
                if stash_sub.is_empty() { "default (push)" } else { stash_sub }
            );
        }
    }

    Ok(())
}

/// Run a git subcommand with token-optimized output.
///
/// Only read-only git subcommands are permitted.
pub fn run_git(subcommand: &str, args: &[&str]) -> Result<CommandOutput> {
    validate_git_policy(subcommand, args)?;
    match subcommand {
        "status" => git_status(args),
        "log" => git_log(args),
        "diff" => git_diff(args),
        "branch" => git_branch(args),
        "show" => git_show(args),
        _ => {
            let mut full_args = vec![subcommand];
            full_args.extend_from_slice(args);
            run("git", &full_args)
        }
    }
}

fn git_status(args: &[&str]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["status", "--porcelain=v1"];

    cmd_args.extend_from_slice(args);
    let output = run("git", &cmd_args)?;

    if output.stdout.trim().is_empty() {
        return Ok(CommandOutput {
            stdout: "clean\n".to_string(),
            stderr: output.stderr,
            exit_code: output.exit_code,
            success: output.success,
        });
    }

    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();

    for line in output.stdout.lines() {
        if line.len() < 3 {
            continue;
        }
        let status = &line[0..2];
        let file = &line[3..];

        if status.starts_with('?') {
            untracked.push(file.to_string());
        } else if let Some(stripped) = status.strip_prefix(' ') {
            unstaged.push((stripped.to_string(), file.to_string()));
        } else {
            staged.push((status[0..1].to_string(), file.to_string()));
        }
    }

    let mut result = String::new();
    if !staged.is_empty() {
        result.push_str(&format!("staged ({}):", staged.len()));
        for (status, file) in &staged {
            result.push_str(&format!("   {} {}", status, file));
        }
        result.push('\n');
    }
    if !unstaged.is_empty() {
        result.push_str(&format!("unstaged ({}):", unstaged.len()));
        for (status, file) in &unstaged {
            result.push_str(&format!("   {} {}", status, file));
        }
        result.push('\n');
    }
    if !untracked.is_empty() {
        result.push_str(&format!("untracked ({}):", untracked.len()));
        for file in &untracked {
            result.push_str(&format!("   {}", file));
        }
        result.push('\n');
    }

    Ok(CommandOutput {
        stdout: result,
        stderr: output.stderr,
        exit_code: output.exit_code,
        success: output.success,
    })
}

fn git_log(args: &[&str]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["log", "--oneline", "--decorate"];
    cmd_args.extend_from_slice(args);
    let output = run("git", &cmd_args)?;

    let lines: Vec<&str> = output.stdout.lines().collect();
    let cap = 20;
    let truncated = lines.len() > cap;
    let display_lines = if truncated { &lines[..cap] } else { &lines };

    let mut result = String::new();
    for line in display_lines {
        // Parse: <sha> <message> (<decorations>)
        if let Some(space_idx) = line.find(' ') {
            let sha = &line[..space_idx];
            let rest = &line[space_idx + 1..];
            result.push_str(&format!("{}  {}\n", sha, rest));
        } else {
            result.push_str(line);
            result.push('\n');
        }
    }

    if truncated {
        result.push_str(&format!("[{} more commits]\n", lines.len() - cap));
    }

    Ok(CommandOutput {
        stdout: result,
        stderr: output.stderr,
        exit_code: output.exit_code,
        success: output.success,
    })
}

fn git_diff(args: &[&str]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["diff"];
    cmd_args.extend_from_slice(args);
    let output = run("git", &cmd_args)?;

    let filtered = filter_diff_output(&output.stdout);
    Ok(CommandOutput {
        stdout: filtered,
        stderr: output.stderr,
        exit_code: output.exit_code,
        success: output.success,
    })
}

fn git_show(args: &[&str]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["show"];
    cmd_args.extend_from_slice(args);
    let output = run("git", &cmd_args)?;

    let filtered = filter_diff_output(&output.stdout);
    Ok(CommandOutput {
        stdout: filtered,
        stderr: output.stderr,
        exit_code: output.exit_code,
        success: output.success,
    })
}

fn filter_diff_output(stdout: &str) -> String {
    let mut result = String::new();
    let mut changed_lines = 0;
    const MAX_CHANGED_LINES: usize = 150;
    let mut file_changes: Vec<(String, usize)> = Vec::new();
    let mut current_file = String::new();
    let mut current_count = 0;

    for line in stdout.lines() {
        if line.starts_with("diff --git") {
            if !current_file.is_empty() && current_count > 0 {
                file_changes.push((current_file.clone(), current_count));
            }
            // Extract filename from "diff --git a/... b/..."
            if let Some(b_idx) = line.find(" b/") {
                current_file = line[b_idx + 3..].to_string();
            } else {
                current_file = line.to_string();
            }
            current_count = 0;
            continue;
        }
        if line.starts_with("index ")
            || line.starts_with("--- ")
            || line.starts_with("+++ ")
            || line.starts_with("mode ")
        {
            continue;
        }
        if line.starts_with("@@") && line.contains("@@") {
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if line.starts_with('+') || line.starts_with('-') {
            if changed_lines >= MAX_CHANGED_LINES {
                current_count += 1;
                continue;
            }
            result.push_str(line);
            result.push('\n');
            changed_lines += 1;
            current_count += 1;
        }
    }

    if !current_file.is_empty() && current_count > 0 {
        file_changes.push((current_file, current_count));
    }

    if changed_lines >= MAX_CHANGED_LINES {
        result.push_str("[diff truncated — showing file list]\n");
        for (file, count) in file_changes {
            result.push_str(&format!("  {} ({} lines)\n", file, count));
        }
    }

    result
}

fn git_branch(args: &[&str]) -> Result<CommandOutput> {
    let mut cmd_args = vec!["branch", "-vv"];
    cmd_args.extend_from_slice(args);
    let output = run("git", &cmd_args)?;

    let mut result = String::new();
    for line in output.stdout.lines() {
        if line.len() < 2 {
            continue;
        }
        let current = line.starts_with('*');
        let rest = &line[2..];

        let parts: Vec<&str> = rest.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }

        let branch_name = parts[0];
        let tracking = parts
            .iter()
            .find(|p| p.starts_with('['))
            .map(|p| p.trim_start_matches('[').trim_end_matches(']'))
            .unwrap_or("no remote");

        let prefix = if current { "*" } else { " " };
        result.push_str(&format!("{} {} → {}\n", prefix, branch_name, tracking));
    }

    Ok(CommandOutput {
        stdout: result,
        stderr: output.stderr,
        exit_code: output.exit_code,
        success: output.success,
    })
}
