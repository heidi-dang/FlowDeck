use fdx::paths::generate_project_id;
use std::fs;
use std::path::Path;

struct PathFixture {
    label: String,
    input: String,
    expected_prefix: String,
}

fn load_path_fixtures() -> Vec<PathFixture> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("tests")
        .join("fixtures");
    let content =
        fs::read_to_string(dir.join("path-scheme.json")).expect("Failed to read path-scheme.json");
    let raw: Vec<serde_json::Value> =
        serde_json::from_str(&content).expect("Failed to parse path-scheme.json");
    raw.iter()
        .map(|v| PathFixture {
            label: v["label"].as_str().unwrap_or("").to_string(),
            input: v["input"].as_str().unwrap_or("").to_string(),
            expected_prefix: v["expected_id_prefix"].as_str().unwrap_or("").to_string(),
        })
        .collect()
}

#[test]
fn test_path_fixture_loads() {
    let fixtures = load_path_fixtures();
    assert!(!fixtures.is_empty(), "Should load at least one fixture");
    assert!(
        fixtures.len() >= 12,
        "Should have at least 12 fixture entries"
    );
}


#[test]
fn test_path_fixture_entries() {
    let fixtures = load_path_fixtures();
    for fx in &fixtures {
        let result = generate_project_id(Path::new(&fx.input));
        assert!(
            result.starts_with(&fx.expected_prefix),
            "{}: expected prefix \"{}\", got \"{}\" (from input \"{}\")",
            fx.label,
            fx.expected_prefix,
            result,
            fx.input
        );
    }
}

#[test]
fn test_same_basename_different_parents_differ() {
    let id1 = generate_project_id(Path::new("/home/user/projects/FlowDeck"));
    let id2 = generate_project_id(Path::new("/home/other/work/FlowDeck"));
    assert_ne!(
        id1, id2,
        "Same basename in different dirs must produce different IDs"
    );
}

#[test]
fn test_deterministic_ids() {
    let id1 = generate_project_id(Path::new("/home/user/project"));
    let id2 = generate_project_id(Path::new("/home/user/project"));
    assert_eq!(id1, id2, "Same input must produce the same ID");
}

#[test]
fn test_hyphenated_name_is_hashed() {
    let result = generate_project_id(Path::new("/tmp/some---repo--name"));
    let parts: Vec<&str> = result.split('-').collect();
    let last = parts.last().unwrap();
    assert_eq!(
        last.len(),
        8,
        "Last part should be 8-char hash, got: {}",
        last
    );
    assert!(
        last.chars().all(|c| c.is_ascii_hexdigit()),
        "Hash should be hex"
    );
    assert!(parts.len() > 1, "Should have more than just a hash");
}

#[test]
fn test_path_with_spaces() {
    let result = generate_project_id(Path::new("/home/user/my project folder"));
    assert!(result.starts_with("my project folder-"));
}

#[test]
fn test_root_path_does_not_panic() {
    let result = generate_project_id(Path::new("/"));
    assert!(result.contains('-'));
}

#[test]
fn test_relative_path() {
    let result = generate_project_id(Path::new("relative/path/to/repo"));
    assert!(result.starts_with("repo-"));
}
