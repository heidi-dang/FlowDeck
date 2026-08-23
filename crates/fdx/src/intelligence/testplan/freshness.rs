//! Test mapping freshness, dynamic config detection, and static Jest/Vitest config parsing.

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaticTestConfig {
    pub config_file: String,
    pub package_dir: String,
    pub include_patterns: Vec<String>,
    pub test_roots: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TestConfigAnalysis {
    Static(StaticTestConfig),
    Dynamic { config_file: String, reason: String },
    Unparseable { config_file: String, reason: String },
}

/// Extract string literals from an array bracket expression like `["foo/**/*.ts", "bar"]`
fn extract_string_array(content: &str, key: &str) -> Option<Vec<String>> {
    let key_pos = content.find(key)?;
    let after_key = &content[key_pos + key.len()..];
    let open_bracket = after_key.find('[')?;
    let close_bracket = after_key[open_bracket..].find(']')? + open_bracket;
    let array_body = &after_key[open_bracket + 1..close_bracket];

    let mut items = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    let mut quote_char = ' ';

    for ch in array_body.chars() {
        if in_quote {
            if ch == quote_char {
                in_quote = false;
                let trimmed = current.trim().to_string();
                if !trimmed.is_empty() {
                    items.push(trimmed);
                }
                current.clear();
            } else {
                current.push(ch);
            }
        } else if ch == '"' || ch == '\'' || ch == '`' {
            in_quote = true;
            quote_char = ch;
        }
    }

    if items.is_empty() {
        None
    } else {
        Some(items)
    }
}

/// Analyze a Jest/Vitest configuration file statically without executing arbitrary code.
pub fn analyze_test_config(path: &Path, content: &str) -> TestConfigAnalysis {
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    // Look for dynamic expressions like process.env, dynamic imports, functions, computed props
    if content.contains("process.env")
        || content.contains("defineConfig(() =>")
        || content.contains("defineConfig(async")
        || content.contains("defineConfig(function")
        || content.contains("require(")
        || content.contains("import.meta.env")
        || content.contains("function()")
        || content.contains("() =>")
    {
        return TestConfigAnalysis::Dynamic {
            config_file: file_name.clone(),
            reason: format!("Dynamic configuration expressions in {}", file_name),
        };
    }

    let mut include_patterns = Vec::new();
    let mut test_roots = Vec::new();

    if let Some(pats) = extract_string_array(content, "include") {
        include_patterns.extend(pats);
    }
    if let Some(pats) = extract_string_array(content, "testMatch") {
        include_patterns.extend(pats);
    }
    if let Some(roots) = extract_string_array(content, "roots") {
        test_roots.extend(roots);
    }

    let parent_dir = path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    TestConfigAnalysis::Static(StaticTestConfig {
        config_file: file_name,
        package_dir: parent_dir,
        include_patterns,
        test_roots,
    })
}

/// Check if dynamic configuration requires conservative widening across the repository.
pub fn detect_dynamic_test_configs(repo_root: &Path) -> Vec<String> {
    let mut reasons = Vec::new();

    let config_candidates = [
        "vitest.config.ts",
        "vitest.config.js",
        "vitest.config.mts",
        "vitest.config.mjs",
        "vitest.config.cjs",
        "vite.config.ts",
        "vite.config.js",
        "jest.config.ts",
        "jest.config.js",
        "jest.config.json",
        "jest.config.mjs",
        "jest.config.cjs",
    ];

    let walker = ignore::WalkBuilder::new(repo_root)
        .hidden(true)
        .git_ignore(true)
        .require_git(false)
        .build();

    for res in walker {
        let Ok(entry) = res else { continue };
        let path = entry.path();
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");

        if config_candidates.contains(&file_name) {
            if let Ok(content) = std::fs::read_to_string(path) {
                match analyze_test_config(path, &content) {
                    TestConfigAnalysis::Dynamic { reason, .. } => {
                        reasons.push(reason);
                    }
                    TestConfigAnalysis::Unparseable { reason, .. } => {
                        reasons.push(reason);
                    }
                    TestConfigAnalysis::Static(_) => {}
                }
            }
        }
    }

    reasons.sort();
    reasons.dedup();
    reasons
}
