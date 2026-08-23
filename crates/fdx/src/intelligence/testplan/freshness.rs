//! Test mapping freshness and old ∪ current union preservation.

use std::path::Path;

/// Check if dynamic configuration requires conservative widening.
pub fn detect_dynamic_test_configs(repo_root: &Path) -> Vec<String> {
    let mut reasons = Vec::new();

    // Check for vitest/jest configs containing dynamic constructs
    let config_candidates = [
        "vitest.config.ts",
        "vitest.config.js",
        "jest.config.ts",
        "jest.config.js",
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
            let content = std::fs::read_to_string(path).unwrap_or_default();
            // Look for dynamic expressions like process.env, dynamic imports, functions
            if content.contains("process.env")
                || content.contains("defineConfig(() =>")
                || content.contains("defineConfig(async")
                || content.contains("require(")
            {
                reasons.push(format!("Dynamic configuration in {}", file_name));
            }
        }
    }

    reasons
}
