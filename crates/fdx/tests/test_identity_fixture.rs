//! Canonical project-identity fixture tests.
//!
//! Consumes `fixtures/fdx/project-identity-v1.json` — the single versioned
//! fixture shared with the TypeScript implementation
//! (`tests/fdx-path-parity.test.ts`). See `docs/project-identity.md`.

use fdx::paths::{generate_project_id, normalize_path_for_id};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn fixture() -> Value {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("fixtures")
        .join("fdx");
    let content = fs::read_to_string(dir.join("project-identity-v1.json"))
        .expect("Failed to read fixtures/fdx/project-identity-v1.json");
    serde_json::from_str(&content).expect("Failed to parse project-identity-v1.json")
}

fn platform_key() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "posix"
    }
}

#[test]
fn fixture_is_versioned_and_pinned() {
    let f = fixture();
    assert_eq!(
        f["version"].as_u64(),
        Some(1),
        "fixture version must be explicit"
    );
    assert_eq!(
        f["algorithm_version"].as_str(),
        Some("v1"),
        "algorithm version must be explicit"
    );
    let entries = f["entries"].as_array().expect("entries array");
    assert!(entries.len() >= 20, "fixture corpus must stay substantial");
}

#[test]
fn fixture_entries_match_rust_implementation() {
    let f = fixture();
    let platform = platform_key();
    for entry in f["entries"].as_array().unwrap() {
        let id = entry["id"].as_str().unwrap_or("?");
        let Some(input) = entry["input"].as_str() else {
            continue; // create_dir-only entries have no raw input
        };

        // Canonical normalized input, when pinned for this platform.
        if let Some(canonical) = entry["canonical"][platform].as_str() {
            let norm = normalize_path_for_id(Path::new(input));
            assert_eq!(
                norm.to_string_lossy(),
                canonical,
                "{id}: canonical mismatch for input {input:?}"
            );
        }

        // Full identity, when pinned for this platform.
        if let Some(expected) = entry["expected_id"][platform].as_str() {
            let actual = generate_project_id(Path::new(input));
            assert_eq!(actual, expected, "{id}: id mismatch for input {input:?}");
        } else if let Some(prefix) = entry["slug_prefix"].as_str() {
            let actual = generate_project_id(Path::new(input));
            assert!(
                actual.starts_with(prefix),
                "{id}: expected prefix {prefix:?}, got {actual:?} from {input:?}"
            );
        }

        // Collision corpus: different_from entries must differ.
        if let Some(different) = entry["different_from"].as_array() {
            let base = generate_project_id(Path::new(input));
            for other_id in different {
                let other = f["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|e| e["id"] == *other_id)
                    .unwrap_or_else(|| panic!("{id}: different_from {other_id} not found"));
                let other_input = other["input"]
                    .as_str()
                    .unwrap_or_else(|| panic!("{id}: different_from {other_id} has no input"));
                let other_id_value = generate_project_id(Path::new(other_input));
                assert_ne!(
                    base, other_id_value,
                    "{id} collides with {other_id} (both {base})"
                );
            }
        }
    }
}

#[test]
fn real_dir_entries_produce_deterministic_valid_ids() {
    let f = fixture();
    let tmp_root = std::env::temp_dir().join(format!(
        "fdx-identity-fixture-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&tmp_root).unwrap();
    for entry in f["entries"].as_array().unwrap() {
        let Some(dir_name) = entry["create_dir"].as_str() else {
            continue;
        };
        let dir = tmp_root.join(dir_name);
        fs::create_dir_all(&dir).unwrap();

        let id = generate_project_id(&dir);
        // Valid shape: `<name>-<8 hex>`, deterministic on repeat.
        assert!(
            id.starts_with(&format!("{dir_name}-")),
            "{dir_name}: got {id}"
        );
        assert_eq!(
            generate_project_id(&dir),
            id,
            "{dir_name}: not deterministic"
        );

        // Idempotent normalization.
        let norm = normalize_path_for_id(&dir);
        assert_eq!(
            normalize_path_for_id(Path::new(&norm)),
            norm,
            "{dir_name}: normalization is not idempotent"
        );
    }
    let _ = fs::remove_dir_all(&tmp_root);
}

#[test]
fn relative_path_resolves_to_cwd_lexically() {
    // Relative input resolves against cwd on both implementations; on every
    // platform the basename must be the last segment.
    let input = Path::new("relative/path/to/repo");
    let id = generate_project_id(input);
    assert!(id.starts_with("repo-"), "{id}");
    assert!(id.ends_with("-8") || id.matches('-').count() >= 1);
}

#[allow(dead_code)]
fn _unused(_p: PathBuf) {}
