//! Test mapping freshness, dynamic config detection, and static Jest/Vitest config parsing.

use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaticTestConfig {
    pub config_file: String,
    pub package_dir: String,
    pub include_patterns: Vec<String>,
    pub test_roots: Vec<String>,
    pub test_regex_patterns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TestConfigAnalysis {
    Static(StaticTestConfig),
    Dynamic { config_file: String, reason: String },
    Unparseable { config_file: String, reason: String },
    Unsupported { config_file: String, reason: String },
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

/// Extract a string literal for a key like `testRegex: "pattern"`
fn extract_string_literal(content: &str, key: &str) -> Option<String> {
    let key_pos = content.find(key)?;
    let after_key = &content[key_pos + key.len()..];
    let mut in_quote = false;
    let mut quote_char = ' ';
    let mut current = String::new();

    for ch in after_key.chars() {
        if in_quote {
            if ch == quote_char {
                return Some(current);
            } else {
                current.push(ch);
            }
        } else if ch == '"' || ch == '\'' || ch == '`' {
            in_quote = true;
            quote_char = ch;
        } else if ch == '\n' || ch == ';' {
            break;
        }
    }

    None
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
    let mut test_regex_patterns = Vec::new();

    if let Some(pats) = extract_string_array(content, "include") {
        include_patterns.extend(pats);
    }
    if let Some(pats) = extract_string_array(content, "testMatch") {
        include_patterns.extend(pats);
    }
    if let Some(roots) = extract_string_array(content, "roots") {
        test_roots.extend(roots);
    }

    if let Some(regex_lit) = extract_string_literal(content, "testRegex") {
        test_regex_patterns.push(regex_lit);
    } else if let Some(regex_arr) = extract_string_array(content, "testRegex") {
        test_regex_patterns.extend(regex_arr);
    }

    if content.contains("testRegex") && test_regex_patterns.is_empty() {
        return TestConfigAnalysis::Unsupported {
            config_file: file_name,
            reason: "Non-literal or complex testRegex pattern expression".to_string(),
        };
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
        test_regex_patterns,
    })
}
