//! Native Model Context Protocol (MCP) server for FDX intelligence.
//!
//! The server uses newline-delimited JSON-RPC over stdin/stdout, the MCP stdio
//! transport. It exposes bounded, repository-jailed FDX intelligence operations
//! to an MCP client such as ChatGPT. It deliberately builds an allowlisted FDX
//! argv for every tool call instead of accepting arbitrary shell commands.

use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use getrandom::fill as random_fill;
use serde_json::{json, Map, Value};

use crate::serve::resolve_contained_path;

const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &[MCP_PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];
const MAX_MESSAGE_BYTES: usize = 256 * 1024;
const MAX_TOOL_OUTPUT_BYTES: usize = 512 * 1024;
const MAX_PATHS: usize = 32;
const DEFAULT_TOOL_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_EXECUTION_TIMEOUT: Duration = Duration::from_secs(330);
const MAX_HTTP_HEADER_BYTES: usize = 16 * 1024;
const SESSION_TTL: Duration = Duration::from_secs(60 * 60);
const MAX_HTTP_CONNECTIONS: usize = 32;

#[derive(Clone, Copy)]
struct ToolAnnotations {
    read_only: bool,
    destructive: bool,
    open_world: bool,
}

impl ToolAnnotations {
    fn json(self) -> Value {
        json!({
            "readOnlyHint": self.read_only,
            "destructiveHint": self.destructive,
            "openWorldHint": self.open_world,
        })
    }
}

fn tool(name: &str, description: &str, input_schema: Value, annotations: ToolAnnotations) -> Value {
    json!({
        "name": name,
        "title": name.replace('_', " "),
        "description": description,
        "inputSchema": input_schema,
        "annotations": annotations.json(),
    })
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

fn tool_definitions() -> Vec<Value> {
    let read_only = ToolAnnotations {
        read_only: true,
        destructive: false,
        open_world: false,
    };
    let executes_checks = ToolAnnotations {
        read_only: false,
        destructive: true,
        open_world: false,
    };
    let changes_local_state = ToolAnnotations {
        read_only: false,
        destructive: true,
        open_world: false,
    };

    vec![
        tool(
            "fdx_intelligence_status",
            "Inspect the local FDX capability contract, index, semantic-provider, or build-provider status before relying on FDX evidence.",
            object_schema(json!({
                "area": {"type":"string", "enum":["capabilities", "index", "semantic", "build"]}
            }), &["area"]),
            read_only,
        ),
        tool(
            "fdx_code_read",
            "Read a repository-jailed source file using FDX token-optimized modes. Use prototype or deep mode before changing code.",
            object_schema(json!({
                "path": {"type":"string", "maxLength":1000},
                "mode": {"type":"string", "enum":["auto", "raw", "prototype", "deep"], "default":"auto"},
                "symbol": {"type":"string", "maxLength":500},
                "offset": {"type":"integer", "minimum":1, "maximum":1000000},
                "limit": {"type":"integer", "minimum":1, "maximum":10000},
                "with_deps": {"type":"boolean", "default":false}
            }), &["path"]),
            read_only,
        ),
        tool(
            "fdx_code_search",
            "Search symbols or outlines in a repository-jailed path through FDX's language-aware index.",
            object_schema(json!({
                "pattern": {"type":"string", "minLength":1, "maxLength":1000},
                "path": {"type":"string", "maxLength":1000, "default":"."},
                "kind": {"type":"string", "enum":["function", "class", "struct", "trait", "interface", "enum", "any"], "default":"any"},
                "max_matches": {"type":"integer", "minimum":1, "maximum":200, "default":50}
            }), &["pattern"]),
            read_only,
        ),
        tool(
            "fdx_code_outline",
            "Return a structured symbol outline for one or more repository-jailed paths.",
            object_schema(json!({
                "paths": {"type":"array", "items":{"type":"string", "maxLength":1000}, "minItems":1, "maxItems":32},
                "depth": {"type":"integer", "minimum":0, "maximum":32},
                "kind": {"type":"string", "maxLength":200},
                "min_lines": {"type":"integer", "minimum":1, "maximum":100000, "default":1}
            }), &["paths"]),
            read_only,
        ),
        tool(
            "fdx_code_grep",
            "Search repository-jailed files with FDX's bounded regex or literal grep. Use this for exact textual patterns that symbol search cannot express.",
            object_schema(json!({
                "pattern": {"type":"string", "minLength":1, "maxLength":1000, "description":"Regex or literal pattern to locate."},
                "path": {"type":"string", "maxLength":1000, "default":".", "description":"Repository-relative search root."},
                "context": {"type":"integer", "minimum":0, "maximum":20, "default":2, "description":"Context lines around each match."},
                "fixed_strings": {"type":"boolean", "default":false, "description":"Treat pattern as literal text instead of a regular expression."},
                "case_sensitive": {"type":"boolean", "default":false, "description":"Preserve case while matching."},
                "max_matches": {"type":"integer", "minimum":1, "maximum":200, "default":50, "description":"Hard result cap."}
            }), &["pattern"]),
            read_only,
        ),
        tool(
            "fdx_workspace_structure",
            "List or tree a repository-jailed directory with FDX's compact, gitignore-aware structure view. Use it before broad exploration; it does not read arbitrary files.",
            object_schema(json!({
                "operation": {"type":"string", "enum":["list", "tree"], "description":"Choose a shallow list or compact tree."},
                "path": {"type":"string", "maxLength":1000, "default":".", "description":"Repository-relative directory."},
                "depth": {"type":"integer", "minimum":0, "maximum":16, "default":3, "description":"Maximum tree depth when operation is tree."},
                "include_hidden": {"type":"boolean", "default":false, "description":"Include hidden entries for list operations."},
                "directories_only": {"type":"boolean", "default":false, "description":"Only include directories for tree operations."}
            }), &["operation"]),
            read_only,
        ),
        tool(
            "fdx_code_diff",
            "Return FDX's symbol-aware diff for a bounded Git base, staged changes, and optional repository-jailed paths. Use it to understand existing changes before planning verification.",
            object_schema(json!({
                "base": {"type":"string", "maxLength":256, "description":"Optional safe Git base reference; defaults to FDX's normal base."},
                "staged": {"type":"boolean", "default":false, "description":"Compare the staging area with HEAD instead of a base reference."},
                "paths": {"type":"array", "items":{"type":"string", "maxLength":1000}, "maxItems":32, "description":"Optional repository-relative paths to limit the diff."}
            }), &[]),
            read_only,
        ),
        tool(
            "fdx_semantic_decode",
            "Decode a repository-jailed SCIP index and return bounded semantic-index statistics without changing provider state.",
            object_schema(json!({
                "file": {"type":"string", "maxLength":1000, "description":"Repository-relative .scip index file to inspect."}
            }), &["file"]),
            read_only,
        ),
        tool(
            "fdx_index_management",
            "Inspect or refresh FDX's native EvidenceGraph index. Refresh writes local FDX evidence and therefore requires explicit user intent.",
            object_schema(json!({
                "action": {"type":"string", "enum":["status", "refresh"], "description":"Read current index state or refresh local evidence."}
            }), &["action"]),
            changes_local_state,
        ),
        tool(
            "fdx_build_graph",
            "Return the local FDX build/configuration graph in JSON. Check build-provider status first when relying on its impact evidence.",
            object_schema(json!({}), &[]),
            read_only,
        ),
        tool(
            "fdx_semantic_references",
            "Find symbol references with explicit FDX semantic provenance, routing intent, freshness, and completeness.",
            object_schema(json!({
                "symbol": {"type":"string", "minLength":1, "maxLength":2000},
                "language": {"type":"string", "enum":["rust", "typescript", "javascript"], "default":"rust"},
                "intent": {"type":"string", "enum":["localize", "reference_complete", "rename", "impact_seed", "context"], "default":"reference_complete"}
            }), &["symbol"]),
            read_only,
        ),
        tool(
            "fdx_change_analysis",
            "Run deterministic FDX change intelligence: transitive impact, an impact explanation, or a verification plan. Review uncertainty and evidence before acting.",
            object_schema(json!({
                "operation": {"type":"string", "enum":["impact", "why", "plan"]},
                "base": {"type":"string", "maxLength":256},
                "head": {"type":"string", "maxLength":256},
                "depth": {"type":"integer", "minimum":1, "maximum":16, "default":3},
                "target": {"type":"string", "maxLength":1000},
                "policy_overlay": {"type":"boolean", "default":false}
            }), &["operation"]),
            read_only,
        ),
        tool(
            "fdx_verification",
            "Plan or execute FDX's bounded verification checks. Execution can run local test commands; use only after the user explicitly asks to validate the change.",
            object_schema(json!({
                "action": {"type":"string", "enum":["plan", "verify"]},
                "base": {"type":"string", "maxLength":256},
                "head": {"type":"string", "maxLength":256},
                "policy_overlay": {"type":"boolean", "default":false},
                "fail_fast": {"type":"boolean", "default":false},
                "persist": {"type":"boolean", "default":false}
            }), &["action"]),
            executes_checks,
        ),
        tool(
            "fdx_intelligence_history",
            "Inspect or reconcile historical FDX verification evidence, including run details, check statistics, and co-occurring changes.",
            object_schema(json!({
                "action": {"type":"string", "enum":["runs", "show", "stats", "cooccurrences", "reconcile"]},
                "run_id": {"type":"string", "maxLength":300},
                "check_id": {"type":"string", "maxLength":500},
                "limit": {"type":"integer", "minimum":1, "maximum":200, "default":50}
            }), &["action"]),
            changes_local_state,
        ),
        tool(
            "fdx_attestation",
            "List, inspect, verify, or create FDX verification attestations. Creation persists a cryptographic local artifact and requires explicit user intent.",
            object_schema(json!({
                "action": {"type":"string", "enum":["list", "show", "verify", "create"]},
                "file": {"type":"string", "maxLength":1000},
                "expected_sha256": {"type":"string", "pattern":"^[a-fA-F0-9]{64}$"},
                "run_id": {"type":"string", "maxLength":300},
                "predicate_version": {"type":"string", "enum":["v1", "v2"], "default":"v1"}
            }), &["action"]),
            changes_local_state,
        ),
        tool(
            "fdx_calibration",
            "Inspect or run bounded FDX shadow calibration. Running calibration executes local verification checks and must follow explicit user approval.",
            object_schema(json!({
                "action": {"type":"string", "enum":["list", "show", "stats", "run"]},
                "run_id": {"type":"string", "maxLength":300},
                "calibration_id": {"type":"string", "maxLength":300},
                "max_checks": {"type":"integer", "minimum":1, "maximum":200, "default":50},
                "max_duration_ms": {"type":"integer", "minimum":1000, "maximum":300000, "default":60000},
                "per_check_timeout_ms": {"type":"integer", "minimum":100, "maximum":60000, "default":10000},
                "scope": {"type":"string", "enum":["affected", "workspace"], "default":"affected"},
                "limit": {"type":"integer", "minimum":1, "maximum":200, "default":50}
            }), &["action"]),
            executes_checks,
        ),
        tool(
            "fdx_verification_policy",
            "Inspect, generate, promote, or revoke FDX's additive learned verification policies. Promotion and revocation persist local policy state and require explicit user intent.",
            object_schema(json!({
                "action": {"type":"string", "enum":["generate", "list", "show", "active", "promote", "revoke"]},
                "candidate_id": {"type":"string", "maxLength":300},
                "policy_id": {"type":"string", "maxLength":300},
                "reason": {"type":"string", "minLength":1, "maxLength":10000},
                "limit": {"type":"integer", "minimum":1, "maximum":200, "default":50}
            }), &["action"]),
            changes_local_state,
        ),
        tool(
            "fdx_provider_refresh",
            "Refresh FDX semantic or build provider discovery without downloads. Use status first and treat degraded evidence conservatively.",
            object_schema(json!({
                "provider_type": {"type":"string", "enum":["semantic", "build"]},
                "provider": {"type":"string", "maxLength":200}
            }), &["provider_type"]),
            changes_local_state,
        ),
    ]
}

fn jsonrpc_result(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "result":result})
}

fn jsonrpc_error(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "error":{"code":code, "message":message.into()}})
}

fn text_result(value: Value, is_error: bool) -> Value {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| "{}".to_string());
    json!({
        "content": [{"type":"text", "text": text}],
        "structuredContent": value,
        "isError": is_error,
    })
}

fn string_arg(
    args: &Value,
    name: &str,
    required: bool,
    max: usize,
) -> Result<Option<String>, String> {
    match args.get(name) {
        Some(Value::String(value)) => {
            if value.is_empty() && required {
                return Err(format!("{} must not be empty", name));
            }
            if value.len() > max || value.contains('\0') {
                return Err(format!("{} is invalid or exceeds its limit", name));
            }
            Ok(Some(value.to_string()))
        }
        Some(_) => Err(format!("{} must be a string", name)),
        None if required => Err(format!("{} is required", name)),
        None => Ok(None),
    }
}

fn bool_arg(args: &Value, name: &str, default: bool) -> Result<bool, String> {
    match args.get(name) {
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(format!("{} must be a boolean", name)),
        None => Ok(default),
    }
}

fn usize_arg(
    args: &Value,
    name: &str,
    default: usize,
    min: usize,
    max: usize,
) -> Result<usize, String> {
    match args.get(name).and_then(Value::as_u64) {
        Some(value) if value >= min as u64 && value <= max as u64 => Ok(value as usize),
        Some(_) => Err(format!("{} must be between {} and {}", name, min, max)),
        None if args.get(name).is_none() => Ok(default),
        None => Err(format!("{} must be an integer", name)),
    }
}

fn enum_arg(
    args: &Value,
    name: &str,
    allowed: &[&str],
    default: Option<&str>,
) -> Result<String, String> {
    let value =
        string_arg(args, name, default.is_none(), 200)?.or_else(|| default.map(str::to_string));
    let value = value.ok_or_else(|| format!("{} is required", name))?;
    if allowed.contains(&value.as_str()) {
        Ok(value)
    } else {
        Err(format!("{} must be one of: {}", name, allowed.join(", ")))
    }
}

fn safe_git_ref(args: &Value, name: &str) -> Result<Option<String>, String> {
    let Some(value) = string_arg(args, name, false, 256)? else {
        return Ok(None);
    };
    if value.chars().all(|ch| {
        ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '/' | '-' | '~' | '^' | '@')
    }) {
        Ok(Some(value))
    } else {
        Err(format!("{} contains unsupported git-ref characters", name))
    }
}

fn safe_target(args: &Value, name: &str, required: bool) -> Result<Option<String>, String> {
    let value = string_arg(args, name, required, 1000)?;
    if let Some(ref raw) = value {
        let path = Path::new(raw);
        if path.is_absolute()
            || path
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err(format!(
                "{} must be a repository-relative path or symbol",
                name
            ));
        }
    }
    Ok(value)
}

fn safe_path(
    root: &Path,
    args: &Value,
    name: &str,
    required: bool,
    must_exist: bool,
) -> Result<Option<String>, String> {
    let Some(raw) = safe_target(args, name, required)? else {
        return Ok(None);
    };
    let resolved = resolve_contained_path(root, Path::new(&raw), must_exist)?;
    let relative = resolved
        .strip_prefix(root)
        .map_err(|_| format!("{} escapes repository root", name))?
        .to_string_lossy()
        .replace('\\', "/");
    Ok(Some(if relative.is_empty() {
        ".".to_string()
    } else {
        relative
    }))
}

fn safe_paths(root: &Path, args: &Value, name: &str) -> Result<Vec<String>, String> {
    let values = args
        .get(name)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("{} must be an array", name))?;
    if values.is_empty() || values.len() > MAX_PATHS {
        return Err(format!(
            "{} must contain between 1 and {} paths",
            name, MAX_PATHS
        ));
    }
    values
        .iter()
        .map(|value| {
            let raw = value
                .as_str()
                .ok_or_else(|| format!("{} values must be strings", name))?;
            let wrapped = json!({"path":raw});
            safe_path(root, &wrapped, "path", true, true)
                .and_then(|path| path.ok_or_else(|| "path is required".to_string()))
        })
        .collect()
}

fn safe_optional_paths(root: &Path, args: &Value, name: &str) -> Result<Vec<String>, String> {
    if args.get(name).is_none() {
        return Ok(Vec::new());
    }
    safe_paths(root, args, name)
}

fn add_option(argv: &mut Vec<String>, flag: &str, value: Option<String>) {
    if let Some(value) = value {
        argv.push(flag.to_string());
        argv.push(value);
    }
}

fn build_cli_argv(name: &str, args: &Value, root: &Path) -> Result<Vec<String>, String> {
    let mut argv = Vec::<String>::new();
    match name {
        "fdx_intelligence_status" => match enum_arg(
            args,
            "area",
            &["capabilities", "index", "semantic", "build"],
            None,
        )?
        .as_str()
        {
            "capabilities" => argv.extend([
                "capabilities".to_string(),
                "--format".to_string(),
                "json".to_string(),
            ]),
            "index" => argv.extend(["index".to_string(), "status".to_string()]),
            "semantic" => argv.extend(["semantic".to_string(), "status".to_string()]),
            "build" => argv.extend(["build".to_string(), "status".to_string()]),
            _ => unreachable!(),
        },
        "fdx_code_read" => {
            argv.push("read".to_string());
            argv.push(safe_path(root, args, "path", true, true)?.unwrap());
            argv.extend([
                "--mode".to_string(),
                enum_arg(
                    args,
                    "mode",
                    &["auto", "raw", "prototype", "deep"],
                    Some("auto"),
                )?,
            ]);
            add_option(
                &mut argv,
                "--symbol",
                string_arg(args, "symbol", false, 500)?,
            );
            if let Some(offset) = args.get("offset") {
                argv.extend([
                    "--offset".to_string(),
                    usize_arg(&json!({"offset":offset}), "offset", 1, 1, 1_000_000)?.to_string(),
                ]);
            }
            if let Some(limit) = args.get("limit") {
                argv.extend([
                    "--limit".to_string(),
                    usize_arg(&json!({"limit":limit}), "limit", 1, 1, 10_000)?.to_string(),
                ]);
            }
            argv.extend([
                "--with-deps".to_string(),
                bool_arg(args, "with_deps", false)?.to_string(),
            ]);
            argv.extend(["--format".to_string(), "json".to_string()]);
        }
        "fdx_code_search" => {
            argv.extend([
                "search".to_string(),
                string_arg(args, "pattern", true, 1000)?.unwrap(),
            ]);
            add_option(
                &mut argv,
                "--path",
                safe_path(root, args, "path", false, true)?.or(Some(".".to_string())),
            );
            argv.extend([
                "--kind".to_string(),
                enum_arg(
                    args,
                    "kind",
                    &[
                        "function",
                        "class",
                        "struct",
                        "trait",
                        "interface",
                        "enum",
                        "any",
                    ],
                    Some("any"),
                )?,
            ]);
            argv.extend([
                "--max-matches".to_string(),
                usize_arg(args, "max_matches", 50, 1, 200)?.to_string(),
                "--format".to_string(),
                "json".to_string(),
            ]);
        }
        "fdx_code_outline" => {
            argv.push("outline".to_string());
            argv.extend(safe_paths(root, args, "paths")?);
            add_option(
                &mut argv,
                "--depth",
                args.get("depth")
                    .map(|_| usize_arg(args, "depth", 0, 0, 32).map(|v| v.to_string()))
                    .transpose()?,
            );
            add_option(&mut argv, "--kind", string_arg(args, "kind", false, 200)?);
            argv.extend([
                "--min-lines".to_string(),
                usize_arg(args, "min_lines", 1, 1, 100_000)?.to_string(),
                "--format".to_string(),
                "json".to_string(),
            ]);
        }
        "fdx_code_grep" => {
            argv.extend([
                "grep".to_string(),
                string_arg(args, "pattern", true, 1000)?.unwrap(),
                "--path".to_string(),
                safe_path(root, args, "path", false, true)?.unwrap_or_else(|| ".".to_string()),
                "--context".to_string(),
                usize_arg(args, "context", 2, 0, 20)?.to_string(),
                "--max-matches".to_string(),
                usize_arg(args, "max_matches", 50, 1, 200)?.to_string(),
            ]);
            if bool_arg(args, "fixed_strings", false)? {
                argv.push("--fixed-strings".to_string());
            }
            if bool_arg(args, "case_sensitive", false)? {
                argv.push("--case-sensitive".to_string());
            }
            argv.extend(["--format".to_string(), "json".to_string()]);
        }
        "fdx_workspace_structure" => {
            let operation = enum_arg(args, "operation", &["list", "tree"], None)?;
            let path =
                safe_path(root, args, "path", false, true)?.unwrap_or_else(|| ".".to_string());
            match operation.as_str() {
                "list" => {
                    argv.extend(["ls".to_string(), path]);
                    if bool_arg(args, "include_hidden", false)? {
                        argv.push("--all".to_string());
                    }
                }
                "tree" => {
                    argv.extend([
                        "tree".to_string(),
                        path,
                        "--depth".to_string(),
                        usize_arg(args, "depth", 3, 0, 16)?.to_string(),
                    ]);
                    if bool_arg(args, "directories_only", false)? {
                        argv.push("--dirs-only".to_string());
                    }
                }
                _ => unreachable!(),
            }
            argv.extend(["--format".to_string(), "json".to_string()]);
        }
        "fdx_code_diff" => {
            argv.push("diff".to_string());
            if let Some(base) = safe_git_ref(args, "base")? {
                argv.push(base);
            }
            if bool_arg(args, "staged", false)? {
                argv.push("--staged".to_string());
            }
            argv.extend(["--format".to_string(), "json".to_string()]);
            let paths = safe_optional_paths(root, args, "paths")?;
            if !paths.is_empty() {
                argv.push("--".to_string());
                argv.extend(paths);
            }
        }
        "fdx_semantic_decode" => {
            argv.extend([
                "semantic".to_string(),
                "decode".to_string(),
                safe_path(root, args, "file", true, true)?.unwrap(),
            ]);
        }
        "fdx_index_management" => {
            match enum_arg(args, "action", &["status", "refresh"], None)?.as_str() {
                "status" => argv.extend(["index".to_string(), "status".to_string()]),
                "refresh" => argv.extend(["index".to_string(), "--refresh".to_string()]),
                _ => unreachable!(),
            }
        }
        "fdx_build_graph" => argv.extend([
            "build".to_string(),
            "graph".to_string(),
            "--format".to_string(),
            "json".to_string(),
        ]),
        "fdx_semantic_references" => {
            argv.extend([
                "semantic".to_string(),
                "references".to_string(),
                string_arg(args, "symbol", true, 2000)?.unwrap(),
            ]);
            argv.extend([
                "--lang".to_string(),
                enum_arg(
                    args,
                    "language",
                    &["rust", "typescript", "javascript"],
                    Some("rust"),
                )?,
            ]);
            argv.extend([
                "--intent".to_string(),
                enum_arg(
                    args,
                    "intent",
                    &[
                        "localize",
                        "reference_complete",
                        "rename",
                        "impact_seed",
                        "context",
                    ],
                    Some("reference_complete"),
                )?,
            ]);
        }
        "fdx_change_analysis" => {
            match enum_arg(args, "operation", &["impact", "why", "plan"], None)?.as_str() {
                "impact" => {
                    argv.push("impact-v2".to_string());
                    add_option(&mut argv, "--base", safe_git_ref(args, "base")?);
                    add_option(&mut argv, "--head", safe_git_ref(args, "head")?);
                    argv.extend([
                        "--depth".to_string(),
                        usize_arg(args, "depth", 3, 1, 16)?.to_string(),
                        "--format".to_string(),
                        "json".to_string(),
                    ]);
                }
                "why" => {
                    argv.extend([
                        "why".to_string(),
                        safe_target(args, "target", true)?.unwrap(),
                    ]);
                    add_option(&mut argv, "--base", safe_git_ref(args, "base")?);
                    add_option(&mut argv, "--head", safe_git_ref(args, "head")?);
                    argv.extend([
                        "--depth".to_string(),
                        usize_arg(args, "depth", 3, 1, 16)?.to_string(),
                        "--format".to_string(),
                        "json".to_string(),
                    ]);
                }
                "plan" => {
                    argv.push("plan".to_string());
                    add_option(&mut argv, "--base", safe_git_ref(args, "base")?);
                    add_option(&mut argv, "--head", safe_git_ref(args, "head")?);
                    if bool_arg(args, "policy_overlay", false)? {
                        argv.push("--policy-overlay".to_string());
                    }
                    argv.extend(["--format".to_string(), "json".to_string()]);
                }
                _ => unreachable!(),
            }
        }
        "fdx_verification" => {
            let action = enum_arg(args, "action", &["plan", "verify"], None)?;
            argv.push(action.clone());
            add_option(&mut argv, "--base", safe_git_ref(args, "base")?);
            add_option(&mut argv, "--head", safe_git_ref(args, "head")?);
            if bool_arg(args, "policy_overlay", false)? {
                argv.push("--policy-overlay".to_string());
            }
            if action == "verify" {
                if bool_arg(args, "fail_fast", false)? {
                    argv.push("--fail-fast".to_string());
                }
                if !bool_arg(args, "persist", false)? {
                    argv.push("--no-persist".to_string());
                }
            }
            argv.extend(["--format".to_string(), "json".to_string()]);
        }
        "fdx_intelligence_history" => match enum_arg(
            args,
            "action",
            &["runs", "show", "stats", "cooccurrences", "reconcile"],
            None,
        )?
        .as_str()
        {
            "runs" => argv.extend([
                "history".to_string(),
                "runs".to_string(),
                "--limit".to_string(),
                usize_arg(args, "limit", 50, 1, 200)?.to_string(),
                "--format".to_string(),
                "json".to_string(),
            ]),
            "show" => argv.extend([
                "history".to_string(),
                "show".to_string(),
                string_arg(args, "run_id", true, 300)?.unwrap(),
                "--format".to_string(),
                "json".to_string(),
            ]),
            "stats" => argv.extend([
                "history".to_string(),
                "stats".to_string(),
                string_arg(args, "check_id", true, 500)?.unwrap(),
                "--format".to_string(),
                "json".to_string(),
            ]),
            "cooccurrences" => argv.extend([
                "history".to_string(),
                "cooccurrences".to_string(),
                string_arg(args, "check_id", true, 500)?.unwrap(),
                "--format".to_string(),
                "json".to_string(),
            ]),
            "reconcile" => argv.extend([
                "history".to_string(),
                "reconcile".to_string(),
                "--format".to_string(),
                "json".to_string(),
            ]),
            _ => unreachable!(),
        },
        "fdx_attestation" => {
            match enum_arg(args, "action", &["list", "show", "verify", "create"], None)?.as_str() {
                "list" => argv.extend([
                    "attest".to_string(),
                    "list".to_string(),
                    "--format".to_string(),
                    "json".to_string(),
                ]),
                "show" => argv.extend([
                    "attest".to_string(),
                    "show".to_string(),
                    safe_path(root, args, "file", true, true)?.unwrap(),
                    "--format".to_string(),
                    "json".to_string(),
                ]),
                "verify" => {
                    argv.extend([
                        "attest".to_string(),
                        "verify".to_string(),
                        safe_path(root, args, "file", true, true)?.unwrap(),
                    ]);
                    add_option(
                        &mut argv,
                        "--expected-sha256",
                        string_arg(args, "expected_sha256", false, 64)?,
                    );
                    argv.extend(["--format".to_string(), "json".to_string()]);
                }
                "create" => {
                    argv.extend([
                        "attest".to_string(),
                        "create".to_string(),
                        "--run".to_string(),
                        string_arg(args, "run_id", true, 300)?.unwrap(),
                        "--predicate-version".to_string(),
                        enum_arg(args, "predicate_version", &["v1", "v2"], Some("v1"))?,
                        "--format".to_string(),
                        "json".to_string(),
                    ]);
                }
                _ => unreachable!(),
            }
        }
        "fdx_calibration" => {
            match enum_arg(args, "action", &["list", "show", "stats", "run"], None)?.as_str() {
                "list" => argv.extend([
                    "calibrate".to_string(),
                    "list".to_string(),
                    "--limit".to_string(),
                    usize_arg(args, "limit", 50, 1, 200)?.to_string(),
                    "--format".to_string(),
                    "json".to_string(),
                ]),
                "show" => argv.extend([
                    "calibrate".to_string(),
                    "show".to_string(),
                    string_arg(args, "calibration_id", true, 300)?.unwrap(),
                    "--format".to_string(),
                    "json".to_string(),
                ]),
                "stats" => argv.extend([
                    "calibrate".to_string(),
                    "stats".to_string(),
                    "--format".to_string(),
                    "json".to_string(),
                ]),
                "run" => argv.extend([
                    "calibrate".to_string(),
                    "run".to_string(),
                    "--run".to_string(),
                    string_arg(args, "run_id", true, 300)?.unwrap(),
                    "--max-checks".to_string(),
                    usize_arg(args, "max_checks", 50, 1, 200)?.to_string(),
                    "--max-duration-ms".to_string(),
                    usize_arg(args, "max_duration_ms", 60_000, 1_000, 300_000)?.to_string(),
                    "--per-check-timeout-ms".to_string(),
                    usize_arg(args, "per_check_timeout_ms", 10_000, 100, 60_000)?.to_string(),
                    "--scope".to_string(),
                    enum_arg(args, "scope", &["affected", "workspace"], Some("affected"))?,
                    "--format".to_string(),
                    "json".to_string(),
                ]),
                _ => unreachable!(),
            }
        }
        "fdx_verification_policy" => match enum_arg(
            args,
            "action",
            &["generate", "list", "show", "active", "promote", "revoke"],
            None,
        )?
        .as_str()
        {
            "generate" => argv.extend([
                "policy".to_string(),
                "generate-candidates".to_string(),
                "--format".to_string(),
                "json".to_string(),
            ]),
            "list" => argv.extend([
                "policy".to_string(),
                "list-candidates".to_string(),
                "--limit".to_string(),
                usize_arg(args, "limit", 50, 1, 200)?.to_string(),
                "--format".to_string(),
                "json".to_string(),
            ]),
            "show" => argv.extend([
                "policy".to_string(),
                "show-candidate".to_string(),
                string_arg(args, "candidate_id", true, 300)?.unwrap(),
                "--format".to_string(),
                "json".to_string(),
            ]),
            "active" => argv.extend([
                "policy".to_string(),
                "list-active".to_string(),
                "--format".to_string(),
                "json".to_string(),
            ]),
            "promote" => argv.extend([
                "policy".to_string(),
                "promote-candidate".to_string(),
                string_arg(args, "candidate_id", true, 300)?.unwrap(),
                "--format".to_string(),
                "json".to_string(),
            ]),
            "revoke" => argv.extend([
                "policy".to_string(),
                "revoke-policy".to_string(),
                string_arg(args, "policy_id", true, 300)?.unwrap(),
                "--reason".to_string(),
                string_arg(args, "reason", true, 10_000)?.unwrap(),
                "--format".to_string(),
                "json".to_string(),
            ]),
            _ => unreachable!(),
        },
        "fdx_provider_refresh" => {
            match enum_arg(args, "provider_type", &["semantic", "build"], None)?.as_str() {
                "semantic" => {
                    argv.extend(["semantic".to_string(), "refresh".to_string()]);
                    add_option(
                        &mut argv,
                        "--provider",
                        string_arg(args, "provider", false, 200)?,
                    );
                }
                "build" => argv.extend(["build".to_string(), "refresh".to_string()]),
                _ => unreachable!(),
            }
        }
        _ => return Err(format!("unknown MCP tool {}", name)),
    }
    Ok(argv)
}

#[derive(Debug)]
struct CapturedOutput {
    text: String,
    truncated: bool,
}

fn capture_bounded<R: Read>(mut reader: R) -> CapturedOutput {
    let mut bytes = Vec::with_capacity(MAX_TOOL_OUTPUT_BYTES.min(16 * 1024));
    let mut buffer = [0u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                let remaining = MAX_TOOL_OUTPUT_BYTES.saturating_sub(bytes.len());
                let accepted = read.min(remaining);
                bytes.extend_from_slice(&buffer[..accepted]);
                if accepted < read {
                    truncated = true;
                }
            }
            Err(_) => break,
        }
    }
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        text.push_str("\n… [FDX output truncated at server safety limit] …");
    }
    CapturedOutput {
        text: text.trim().to_string(),
        truncated,
    }
}

fn tool_timeout(argv: &[String]) -> Duration {
    match argv.first().map(String::as_str) {
        Some("verify") => MAX_EXECUTION_TIMEOUT,
        Some("calibrate") if argv.get(1).map(String::as_str) == Some("run") => {
            MAX_EXECUTION_TIMEOUT
        }
        _ => DEFAULT_TOOL_TIMEOUT,
    }
}

fn run_fdx(argv: &[String], root: &Path) -> Result<Value, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("cannot locate fdx executable: {}", error))?;
    let mut child = Command::new(executable)
        .args(argv)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to run FDX: {}", error))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "failed to capture FDX stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "failed to capture FDX stderr".to_string())?;
    let stdout_reader = thread::spawn(move || capture_bounded(stdout));
    let stderr_reader = thread::spawn(move || capture_bounded(stderr));
    let timeout = tool_timeout(argv);
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!(
                    "FDX command timed out after {} seconds and was terminated",
                    timeout.as_secs()
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("failed while waiting for FDX: {}", error));
            }
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "FDX stdout capture thread panicked".to_string())?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "FDX stderr capture thread panicked".to_string())?;
    if !status.success() {
        let message = if stderr.text.is_empty() {
            format!("FDX command failed with status {}", status)
        } else {
            stderr.text
        };
        return Err(if stderr.truncated {
            format!("{} (stderr was truncated)", message)
        } else {
            message
        });
    }
    if stdout.text.is_empty() {
        return Ok(json!({"status":"ok"}));
    }
    if !stdout.truncated {
        if let Ok(value) = serde_json::from_str::<Value>(&stdout.text) {
            return Ok(value);
        }
    }
    Ok(json!({
        "text": stdout.text,
        "format": "text",
        "truncated": stdout.truncated,
    }))
}

fn tool_call(name: &str, args: &Value, root: &Path) -> Value {
    match build_cli_argv(name, args, root).and_then(|argv| run_fdx(&argv, root)) {
        Ok(value) => text_result(value, false),
        Err(error) => text_result(json!({"error": error}), true),
    }
}

#[derive(Default)]
struct ConnectionState {
    negotiated_protocol: Option<&'static str>,
    initialized: bool,
}

fn server_instructions() -> &'static str {
    "Use FDX tools only for the configured repository. Start with fdx_intelligence_status, preserve uncertainty and provenance in conclusions, call fdx_verification with action=plan before verify, and obtain explicit user confirmation before tools marked as write or execution actions."
}

fn unsupported_protocol_error(id: Value, requested: &str) -> Value {
    jsonrpc_error(
        id,
        -32602,
        format!(
            "unsupported MCP protocol version {}; supported versions: {}",
            requested,
            SUPPORTED_PROTOCOL_VERSIONS.join(", ")
        ),
    )
}

fn handle_message(message: Value, root: &Path, state: &mut ConnectionState) -> Option<Value> {
    let id = message.get("id").cloned();
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return id
            .map(|id| jsonrpc_error(id, -32600, "invalid JSON-RPC request: method is required"));
    };
    match method {
        "initialize" => {
            let id = id?;
            if state.negotiated_protocol.is_some() {
                return Some(jsonrpc_error(
                    id,
                    -32600,
                    "MCP connection is already initialized",
                ));
            }
            let Some(params) = message.get("params").and_then(Value::as_object) else {
                return Some(jsonrpc_error(id, -32602, "initialize requires params"));
            };
            let Some(requested) = params.get("protocolVersion").and_then(Value::as_str) else {
                return Some(jsonrpc_error(
                    id,
                    -32602,
                    "initialize requires params.protocolVersion",
                ));
            };
            let Some(selected) = SUPPORTED_PROTOCOL_VERSIONS
                .iter()
                .copied()
                .find(|version| *version == requested)
            else {
                return Some(unsupported_protocol_error(id, requested));
            };
            state.negotiated_protocol = Some(selected);
            state.initialized = false;
            Some(jsonrpc_result(
                id,
                json!({
                    "protocolVersion": selected,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name":"fdx-intelligence", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": server_instructions(),
                }),
            ))
        }
        "notifications/initialized" => {
            if state.negotiated_protocol.is_some() {
                state.initialized = true;
            }
            None
        }
        "ping" => id.map(|id| jsonrpc_result(id, json!({}))),
        "tools/list" | "tools/call" if !state.initialized => id.map(|id| {
            jsonrpc_error(
                id,
                -32002,
                "MCP client must send notifications/initialized before using tools",
            )
        }),
        "tools/list" => Some(jsonrpc_result(
            id.unwrap_or(Value::Null),
            json!({"tools": tool_definitions()}),
        )),
        "tools/call" => {
            let id = id?;
            let params = message
                .get("params")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let name = params.get("name").and_then(Value::as_str);
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            match name {
                Some(name) => Some(jsonrpc_result(id, tool_call(name, &arguments, root))),
                None => Some(jsonrpc_error(id, -32602, "tools/call requires params.name")),
            }
        }
        _ => id.map(|id| jsonrpc_error(id, -32601, format!("method not found: {}", method))),
    }
}

/// Run the native FDX MCP server over stdio for one repository.
///
/// `fdx mcp --root <repository>` starts a single server that services the
/// repository-scoped ChatGPT tool calls until stdin reaches EOF.
pub fn run(root_opt: Option<PathBuf>) {
    let raw_root = root_opt.unwrap_or_else(|| PathBuf::from("."));
    let root = match std::fs::canonicalize(&raw_root) {
        Ok(root) => root,
        Err(error) => {
            eprintln!(
                "fdx mcp: cannot resolve repository root {:?}: {}",
                raw_root, error
            );
            return;
        }
    };

    let stdin = std::io::stdin();
    let mut reader = std::io::BufReader::new(stdin.lock());
    let stdout = std::io::stdout();
    let mut writer = stdout.lock();
    let mut line = String::new();
    let mut state = ConnectionState::default();

    loop {
        line.clear();
        let bytes = match reader.read_line(&mut line) {
            Ok(0) => break,
            Ok(bytes) => bytes,
            Err(_) => break,
        };
        if bytes > MAX_MESSAGE_BYTES {
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let message = match serde_json::from_str::<Value>(trimmed) {
            Ok(message) => message,
            Err(_) => continue,
        };
        if let Some(response) = handle_message(message, &root, &mut state) {
            if let Ok(serialized) = serde_json::to_string(&response) {
                let _ = writer.write_all(serialized.as_bytes());
                let _ = writer.write_all(b"\n");
                let _ = writer.flush();
            }
        }
    }
}

/// Configuration for the remote streaming-HTTP MCP transport. This listener is
/// intentionally transport-only: TLS and OAuth validation belong at an edge
/// proxy, which forwards a configured bearer capability to the local listener.
#[derive(Clone)]
pub struct HttpServerConfig {
    pub listen: SocketAddr,
    pub bearer_token: String,
    pub allowed_origins: Vec<String>,
}

#[derive(Default)]
struct HttpSessionStore {
    sessions: HashMap<String, Arc<HttpSession>>,
}

struct HttpSession {
    state: Mutex<ConnectionState>,
    expires_at: Mutex<Instant>,
}

struct HttpRequest {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.as_bytes()
        .iter()
        .zip(right.as_bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

fn new_session_id() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    random_fill(&mut bytes)
        .map_err(|error| format!("cannot generate MCP session ID: {}", error))?;
    Ok(bytes.iter().map(|byte| format!("{:02x}", byte)).collect())
}

fn read_http_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|error| format!("cannot set HTTP read timeout: {}", error))?;
    let mut header_bytes = Vec::new();
    let mut byte = [0u8; 1];
    while header_bytes.len() < MAX_HTTP_HEADER_BYTES {
        let count = stream
            .read(&mut byte)
            .map_err(|error| format!("cannot read HTTP request: {}", error))?;
        if count == 0 {
            return Err("HTTP client disconnected before headers".to_string());
        }
        header_bytes.push(byte[0]);
        if header_bytes.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    if !header_bytes.ends_with(b"\r\n\r\n") {
        return Err("HTTP request headers exceed the configured limit".to_string());
    }
    let header_text =
        std::str::from_utf8(&header_bytes).map_err(|_| "HTTP headers must be UTF-8".to_string())?;
    let mut lines = header_text.split("\r\n");
    let request_line = lines
        .next()
        .ok_or_else(|| "HTTP request line is missing".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts
        .next()
        .ok_or_else(|| "HTTP request method is missing".to_string())?
        .to_string();
    let path = request_parts
        .next()
        .ok_or_else(|| "HTTP request target is missing".to_string())?
        .to_string();
    if request_parts.next().is_none() {
        return Err("HTTP version is missing".to_string());
    }
    let mut headers = HashMap::new();
    for line in lines {
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            return Err("malformed HTTP header".to_string());
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim().to_string();
        if headers.insert(name, value).is_some() {
            return Err("duplicate HTTP headers are not supported".to_string());
        }
    }
    if headers.contains_key("transfer-encoding") {
        return Err("chunked or transfer-encoded HTTP bodies are not supported".to_string());
    }
    let content_length = match headers.get("content-length") {
        Some(value) => value
            .parse::<usize>()
            .map_err(|_| "invalid Content-Length".to_string())?,
        None => 0,
    };
    if content_length > MAX_MESSAGE_BYTES {
        return Err("HTTP request body exceeds the configured limit".to_string());
    }
    let mut body = vec![0u8; content_length];
    stream
        .read_exact(&mut body)
        .map_err(|error| format!("cannot read HTTP request body: {}", error))?;
    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn write_http_response(
    stream: &mut TcpStream,
    status: u16,
    body: Option<&Value>,
    session_id: Option<&str>,
    origin: Option<&str>,
) {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        415 => "Unsupported Media Type",
        429 => "Too Many Requests",
        _ => "Internal Server Error",
    };
    let rendered = body
        .and_then(|value| serde_json::to_vec(value).ok())
        .unwrap_or_default();
    let mut headers = format!(
        "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n",
        status,
        reason,
        rendered.len()
    );
    if body.is_some() {
        headers.push_str("Content-Type: application/json\r\n");
    }
    if let Some(session_id) = session_id {
        headers.push_str(&format!("Mcp-Session-Id: {}\r\n", session_id));
    }
    if let Some(origin) = origin {
        headers.push_str(&format!(
            "Access-Control-Allow-Origin: {}\r\nVary: Origin\r\n",
            origin
        ));
    }
    headers.push_str("\r\n");
    let _ = stream.write_all(headers.as_bytes());
    let _ = stream.write_all(&rendered);
    let _ = stream.flush();
}

fn http_error(id: Option<Value>, code: i64, message: impl Into<String>) -> Value {
    jsonrpc_error(id.unwrap_or(Value::Null), code, message)
}

fn origin_is_allowed(
    request: &HttpRequest,
    config: &HttpServerConfig,
) -> Result<Option<String>, String> {
    let Some(origin) = request.headers.get("origin") else {
        return Ok(None);
    };
    if config
        .allowed_origins
        .iter()
        .any(|allowed| allowed == origin)
    {
        Ok(Some(origin.clone()))
    } else {
        Err("request Origin is not allowlisted".to_string())
    }
}

fn bearer_is_valid(request: &HttpRequest, config: &HttpServerConfig) -> bool {
    let Some(authorization) = request.headers.get("authorization") else {
        return false;
    };
    let Some(token) = authorization.strip_prefix("Bearer ") else {
        return false;
    };
    constant_time_eq(token, &config.bearer_token)
}

fn prune_expired_sessions(store: &mut HttpSessionStore) {
    let now = Instant::now();
    store.sessions.retain(|_, session| {
        session
            .expires_at
            .lock()
            .map(|expires_at| *expires_at > now)
            .unwrap_or(false)
    });
}

fn handle_http_connection(
    mut stream: TcpStream,
    root: Arc<PathBuf>,
    sessions: Arc<Mutex<HttpSessionStore>>,
    config: Arc<HttpServerConfig>,
) {
    let request = match read_http_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            write_http_response(
                &mut stream,
                400,
                Some(&http_error(None, -32600, error)),
                None,
                None,
            );
            return;
        }
    };
    let origin = match origin_is_allowed(&request, &config) {
        Ok(origin) => origin,
        Err(error) => {
            write_http_response(
                &mut stream,
                403,
                Some(&http_error(None, -32001, error)),
                None,
                None,
            );
            return;
        }
    };
    if request.path != "/mcp" {
        write_http_response(&mut stream, 404, None, None, origin.as_deref());
        return;
    }
    if request.method == "OPTIONS" {
        if origin.is_none() {
            write_http_response(&mut stream, 403, None, None, None);
        } else {
            let mut response = json!({});
            response["allow"] = json!(["POST", "OPTIONS"]);
            write_http_response(&mut stream, 204, None, None, origin.as_deref());
        }
        return;
    }
    if request.method != "POST" {
        write_http_response(&mut stream, 405, None, None, origin.as_deref());
        return;
    }
    if !request.headers.get("content-type").is_some_and(|value| {
        value
            .split(';')
            .next()
            .is_some_and(|mime| mime.trim() == "application/json")
    }) {
        write_http_response(&mut stream, 415, None, None, origin.as_deref());
        return;
    }
    if !bearer_is_valid(&request, &config) {
        write_http_response(&mut stream, 401, None, None, origin.as_deref());
        return;
    }
    let message = match serde_json::from_slice::<Value>(&request.body) {
        Ok(message) => message,
        Err(_) => {
            write_http_response(
                &mut stream,
                400,
                Some(&http_error(None, -32700, "invalid JSON-RPC payload")),
                None,
                origin.as_deref(),
            );
            return;
        }
    };
    let id = message.get("id").cloned();
    let is_initialize = message.get("method").and_then(Value::as_str) == Some("initialize");
    let requested_session = request.headers.get("mcp-session-id").cloned();
    let mut store = match sessions.lock() {
        Ok(store) => store,
        Err(_) => {
            write_http_response(
                &mut stream,
                500,
                Some(&http_error(id, -32603, "MCP session state is unavailable")),
                None,
                origin.as_deref(),
            );
            return;
        }
    };
    prune_expired_sessions(&mut store);
    let session_id = if is_initialize {
        if requested_session.is_some() {
            write_http_response(
                &mut stream,
                400,
                Some(&http_error(
                    id,
                    -32600,
                    "initialize must not include Mcp-Session-Id",
                )),
                None,
                origin.as_deref(),
            );
            return;
        }
        match new_session_id() {
            Ok(session_id) => {
                store.sessions.insert(
                    session_id.clone(),
                    Arc::new(HttpSession {
                        state: Mutex::new(ConnectionState::default()),
                        expires_at: Mutex::new(Instant::now() + SESSION_TTL),
                    }),
                );
                session_id
            }
            Err(error) => {
                write_http_response(
                    &mut stream,
                    500,
                    Some(&http_error(id, -32603, error)),
                    None,
                    origin.as_deref(),
                );
                return;
            }
        }
    } else {
        let Some(session_id) = requested_session else {
            write_http_response(
                &mut stream,
                400,
                Some(&http_error(
                    id,
                    -32002,
                    "Mcp-Session-Id is required after initialize",
                )),
                None,
                origin.as_deref(),
            );
            return;
        };
        if !store.sessions.contains_key(&session_id) {
            write_http_response(&mut stream, 404, None, None, origin.as_deref());
            return;
        }
        session_id
    };
    let Some(session) = store.sessions.get(&session_id).cloned() else {
        write_http_response(&mut stream, 404, None, None, origin.as_deref());
        return;
    };
    drop(store);
    if let Ok(mut expires_at) = session.expires_at.lock() {
        *expires_at = Instant::now() + SESSION_TTL;
    }
    let response = match session.state.lock() {
        Ok(mut state) => handle_message(message, &root, &mut state),
        Err(_) => Some(http_error(id, -32603, "MCP session state is unavailable")),
    };
    match response {
        Some(response) => write_http_response(
            &mut stream,
            200,
            Some(&response),
            Some(&session_id),
            origin.as_deref(),
        ),
        None => write_http_response(&mut stream, 202, None, Some(&session_id), origin.as_deref()),
    }
}

/// Start the remote streaming-HTTP MCP endpoint at `POST /mcp`.
///
/// The listener accepts only requests authenticated with `bearer_token`. Bind
/// it to loopback and deploy a TLS/OAuth reverse proxy in front of it for
/// ChatGPT Developer Mode; never expose this local repository service directly.
pub fn run_http(root_opt: Option<PathBuf>, config: HttpServerConfig) -> Result<(), String> {
    if config.bearer_token.len() < 16 {
        return Err("FDX MCP HTTP bearer token must be at least 16 characters".to_string());
    }
    if !config.listen.ip().is_loopback() {
        return Err("FDX MCP HTTP must bind to a loopback address; use a TLS/OAuth reverse proxy for remote access".to_string());
    }
    let raw_root = root_opt.unwrap_or_else(|| PathBuf::from("."));
    let root = std::fs::canonicalize(&raw_root)
        .map_err(|error| format!("cannot resolve repository root {:?}: {}", raw_root, error))?;
    let listener = TcpListener::bind(config.listen)
        .map_err(|error| format!("cannot bind FDX MCP HTTP listener: {}", error))?;
    eprintln!(
        "fdx mcp http listening on http://{}/mcp (loopback only)",
        config.listen
    );
    let root = Arc::new(root);
    let sessions = Arc::new(Mutex::new(HttpSessionStore::default()));
    let config = Arc::new(config);
    let active_connections = Arc::new(AtomicUsize::new(0));
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let acquired = active_connections.fetch_update(
                    Ordering::AcqRel,
                    Ordering::Acquire,
                    |active| (active < MAX_HTTP_CONNECTIONS).then_some(active + 1),
                );
                if acquired.is_err() {
                    drop(stream);
                    continue;
                }
                let root = Arc::clone(&root);
                let sessions = Arc::clone(&sessions);
                let config = Arc::clone(&config);
                let active_connections = Arc::clone(&active_connections);
                thread::spawn(move || {
                    handle_http_connection(stream, root, sessions, config);
                    active_connections.fetch_sub(1, Ordering::Release);
                });
            }
            Err(error) => eprintln!("fdx mcp http accept error: {}", error),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn advertises_the_full_fdx_intelligence_tool_surface() {
        let tools = tool_definitions();
        let names: Vec<&str> = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect();
        assert_eq!(names.len(), 18);
        assert!(names.contains(&"fdx_code_grep"));
        assert!(names.contains(&"fdx_workspace_structure"));
        assert!(names.contains(&"fdx_code_diff"));
        assert!(names.contains(&"fdx_semantic_decode"));
        assert!(names.contains(&"fdx_index_management"));
        assert!(names.contains(&"fdx_build_graph"));
        assert!(names.contains(&"fdx_change_analysis"));
        assert!(names.contains(&"fdx_verification"));
        assert!(names.contains(&"fdx_attestation"));
        assert!(names.contains(&"fdx_verification_policy"));
    }

    #[test]
    fn rejects_paths_that_escape_the_repository_for_mcp_calls() {
        let root = tempdir().unwrap();
        let result = build_cli_argv(
            "fdx_code_read",
            &json!({"path":"../outside.rs"}),
            root.path(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn builds_a_bounded_non_persistent_verification_command_by_default() {
        let root = tempdir().unwrap();
        let argv = build_cli_argv(
            "fdx_verification",
            &json!({"action":"verify", "base":"HEAD~1"}),
            root.path(),
        )
        .unwrap();
        assert_eq!(argv[0], "verify");
        assert!(argv.contains(&"--no-persist".to_string()));
        assert!(argv.contains(&"--format".to_string()));
    }

    #[test]
    fn explicitly_controls_dependency_expansion_for_reads() {
        let root = tempdir().unwrap();
        std::fs::write(root.path().join("source.rs"), "fn main() {}\n").unwrap();
        let argv = build_cli_argv(
            "fdx_code_read",
            &json!({"path":"source.rs", "with_deps":false}),
            root.path(),
        )
        .unwrap();
        assert!(argv.windows(2).any(|pair| pair == ["--with-deps", "false"]));
    }

    #[test]
    fn rejects_unsafe_git_ref_input_before_command_execution() {
        let root = tempdir().unwrap();
        let result = build_cli_argv(
            "fdx_change_analysis",
            &json!({"operation":"impact", "base":"HEAD;rm -rf /"}),
            root.path(),
        );
        assert!(result.is_err());
    }

    #[test]
    fn returns_a_standard_mcp_initialize_response() {
        let root = tempdir().unwrap();
        let mut state = ConnectionState::default();
        let response = handle_message(
            json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"protocolVersion":MCP_PROTOCOL_VERSION, "capabilities":{}, "clientInfo":{"name":"test", "version":"1"}}}),
            root.path(),
            &mut state,
        )
        .unwrap();
        assert_eq!(response["result"]["protocolVersion"], MCP_PROTOCOL_VERSION);
        assert_eq!(response["result"]["serverInfo"]["name"], "fdx-intelligence");
        assert!(!state.initialized);
    }

    #[test]
    fn rejects_tools_before_initialized_notification() {
        let root = tempdir().unwrap();
        let mut state = ConnectionState::default();
        let response = handle_message(
            json!({"jsonrpc":"2.0", "id":1, "method":"tools/list", "params":{}}),
            root.path(),
            &mut state,
        )
        .unwrap();
        assert_eq!(response["error"]["code"], -32002);
    }

    #[test]
    fn rejects_unsupported_protocol_versions() {
        let root = tempdir().unwrap();
        let mut state = ConnectionState::default();
        let response = handle_message(
            json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"protocolVersion":"unsupported", "capabilities":{}, "clientInfo":{"name":"test", "version":"1"}}}),
            root.path(),
            &mut state,
        )
        .unwrap();
        assert_eq!(response["error"]["code"], -32602);
        assert!(state.negotiated_protocol.is_none());
    }

    #[test]
    fn exposes_tools_only_after_successful_lifecycle_completion() {
        let root = tempdir().unwrap();
        let mut state = ConnectionState::default();
        let _ = handle_message(
            json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"protocolVersion":MCP_PROTOCOL_VERSION, "capabilities":{}, "clientInfo":{"name":"test", "version":"1"}}}),
            root.path(),
            &mut state,
        );
        let notification = handle_message(
            json!({"jsonrpc":"2.0", "method":"notifications/initialized", "params":{}}),
            root.path(),
            &mut state,
        );
        assert!(notification.is_none());
        let response = handle_message(
            json!({"jsonrpc":"2.0", "id":2, "method":"tools/list", "params":{}}),
            root.path(),
            &mut state,
        )
        .unwrap();
        assert!(response["result"]["tools"].is_array());
    }
}
