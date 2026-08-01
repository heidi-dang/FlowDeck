//! Crash-safe generation-based storage for the FDX index.
//!
//! Write lifecycle (Task 3 §6):
//!
//! 1. build a new generation in a sibling temporary directory;
//! 2. write every component + the manifest;
//! 3. validate the manifest and component checksums;
//! 4. fsync the generation directory;
//! 5. atomically publish the new generation (rename tmp → final);
//! 6. update the CURRENT pointer last;
//! 7. retain the previous valid generation until activation succeeds;
//! 8. clean stale temporary generations.
//!
//! On corruption: quarantine the corrupt component/generation (retaining
//! diagnostic evidence), rebuild only the affected layer where safe, fall
//! back to one-shot/TS behaviour while rebuilding, and never return corrupt
//! index data.

use crate::index::manifest::{FdxIndexManifest, IndexIdentity, INDEX_SCHEMA_VERSION};
use crate::index::paths::{
    current_pointer, ensure_state_root, ensure_state_version, generation_dir, generation_tmp_dir,
    quarantine_dir, worktree_dir,
};
use std::io::Write;
use std::path::{Path, PathBuf};

/// How many previous valid generations to retain after a successful publish.
pub const RETAIN_GENERATIONS: usize = 1;

/// One named component file inside a generation directory.
pub const COMPONENT_FILES: [&str; 6] = [
    "files.json",
    "symbols.json",
    "dependencies.json",
    "test-mapping.json",
    "git-state.json",
    "content-cache.json",
];

/// The manifest file name inside a generation directory.
pub const MANIFEST_FILE: &str = "manifest.json";

/// Result of loading a persisted generation.
#[derive(Debug)]
pub enum LoadOutcome {
    /// A valid generation was loaded and activated.
    Loaded(FdxIndexManifest),
    /// No persisted generation exists yet.
    Empty,
    /// A persisted generation exists but is corrupt; it was quarantined.
    /// `last_valid` is the most recent *valid* manifest found before the
    /// corrupt one (if any).
    Corrupt {
        quarantined: Vec<PathBuf>,
        last_valid: Option<FdxIndexManifest>,
    },
    /// A persisted generation has a newer schema than this binary supports.
    FutureSchema {
        generation: u64,
        schema_version: u32,
    },
}

/// The storage layer: knows how to persist and load index generations.
pub struct GenerationStore {
    /// Resolved state root (contains `fdx-index/...`). Retained for
    /// observability/debugging.
    #[allow(dead_code)]
    state_root: PathBuf,
    /// Worktree directory holding all generations for this identity.
    worktree: PathBuf,
}

impl GenerationStore {
    /// Create a store for the given identity, ensuring the state tree exists.
    pub fn open(state_root: &Path, identity: &IndexIdentity) -> std::io::Result<Self> {
        let root = ensure_state_root(state_root)?;
        ensure_state_version(&root)?;
        let wt = worktree_dir(&root, &identity.repository_id, &identity.worktree_id);
        Ok(Self {
            state_root: root,
            worktree: wt,
        })
    }

    /// Directory for a specific generation.
    pub fn generation_path(&self, generation: u64) -> PathBuf {
        generation_dir(&self.worktree, generation)
    }

    /// The worktree state dir (for tests/observability).
    pub fn worktree_path(&self) -> &Path {
        &self.worktree
    }

    /// Read the CURRENT pointer: the active generation number, if any.
    pub fn current_generation(&self) -> std::io::Result<Option<u64>> {
        let ptr = current_pointer(&self.worktree);
        match std::fs::read_to_string(&ptr) {
            Ok(s) => match s.trim().parse::<u64>() {
                Ok(n) => Ok(Some(n)),
                Err(_) => Ok(None),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// List persisted generations (from directory names), sorted ascending.
    pub fn persisted_generations(&self) -> Vec<u64> {
        let mut gens = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&self.worktree) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if let Some(num) = name.strip_prefix("gen-") {
                    if let Ok(n) = num.parse::<u64>() {
                        gens.push(n);
                    }
                }
            }
        }
        gens.sort_unstable();
        gens
    }

    /// Remove every persisted generation and the CURRENT pointer (used by
    /// `index.invalidate` so a later refresh starts from a clean slate).
    pub fn clear_persisted(&self) -> std::io::Result<()> {
        for gen in self.persisted_generations() {
            let _ = std::fs::remove_dir_all(self.generation_path(gen));
        }
        let ptr = current_pointer(&self.worktree);
        match std::fs::remove_file(&ptr) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        Ok(())
    }

    /// Remove stale `.tmp` generation dirs (called on refresh, including the
    /// no-change path, so interrupted writes never accumulate).
    pub fn cleanup_stale_tmp(&self) {
        if let Ok(entries) = std::fs::read_dir(&self.worktree) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(".tmp") {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }

    /// Load and validate the current generation (or the newest valid one).
    ///
    /// Returns the outcome; corrupt generations are quarantined. This is a
    /// read-only activation: no components are loaded here, only the manifest
    /// is validated (component loading happens in the index service).
    pub fn load(&self) -> LoadOutcome {
        let Some(current) = self.current_generation().unwrap_or(None) else {
            return LoadOutcome::Empty;
        };

        let mut last_valid: Option<FdxIndexManifest> = None;
        // Walk from newest to oldest; find the newest valid generation.
        let mut gens = self.persisted_generations();
        gens.reverse();
        let mut quarantined = Vec::new();

        for gen in gens {
            let path = self.generation_path(gen);
            match read_valid_manifest(&path, gen) {
                Ok(manifest) => {
                    last_valid = Some(manifest);
                    break;
                }
                Err(e) => {
                    // Quarantine the corrupt generation (keep evidence).
                    let reason = e.to_string();
                    let dst = self.quarantine(&path, gen, &reason);
                    quarantined.push(dst);
                }
            }
        }

        match last_valid {
            Some(manifest) => {
                // If the quarantined generation was the CURRENT pointer,
                // re-point to the newly activated generation.
                if quarantined_was_current(&quarantined, current) {
                    let _ = self.write_current_pointer(manifest.generation);
                }
                LoadOutcome::Loaded(manifest)
            }
            None => {
                // Nothing valid. If we quarantined something, report it.
                if quarantined.is_empty() {
                    LoadOutcome::Empty
                } else {
                    LoadOutcome::Corrupt {
                        quarantined,
                        last_valid: None,
                    }
                }
            }
        }
    }

    /// Atomically publish a new generation.
    ///
    /// `build` writes the generation into the temporary sibling directory and
    /// returns the manifest. This function then:
    /// 1. validates the manifest's schema;
    /// 2. verifies every listed component checksum;
    /// 3. fsyncs the tmp dir;
    /// 4. renames tmp → final;
    /// 5. atomically updates CURRENT;
    /// 6. retains the previous valid generation;
    /// 7. cleans stale `.tmp` siblings.
    pub fn publish<F>(
        &self,
        generation: u64,
        _identity: &IndexIdentity,
        _fdx_version: &str,
        _now_iso: &str,
        build: F,
    ) -> std::io::Result<FdxIndexManifest>
    where
        F: FnOnce(&Path) -> std::io::Result<FdxIndexManifest>,
    {
        let tmp = generation_tmp_dir(&self.worktree, generation);
        if tmp.exists() {
            let _ = std::fs::remove_dir_all(&tmp);
        }
        std::fs::create_dir_all(&tmp)?;

        // 1. Build components in the tmp dir; `publish` writes the manifest
        //    itself so callers cannot forget it.
        let manifest = build(&tmp)?;

        // 2. Validate schema: reject unsupported future schemas.
        if manifest.schema_version > INDEX_SCHEMA_VERSION {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "index schema {} is newer than supported {}",
                    manifest.schema_version, INDEX_SCHEMA_VERSION
                ),
            ));
        }

        // 3. Write the manifest file last (the commit point of the
        //    generation), then verify all component checksums.
        {
            let bytes = serde_json::to_vec_pretty(&manifest).map_err(std::io::Error::other)?;
            let mut f = std::fs::File::create(tmp.join(MANIFEST_FILE))?;
            f.write_all(&bytes)?;
            f.sync_all()?;
        }
        verify_checksums(&tmp, &manifest)?;

        // 4. fsync the tmp dir contents.
        sync_dir(&tmp)?;

        // 5. Atomically rename tmp → final.
        let final_dir = generation_dir(&self.worktree, generation);
        if final_dir.exists() {
            let _ = std::fs::remove_dir_all(&final_dir);
        }
        std::fs::rename(&tmp, &final_dir)?;
        sync_dir(&self.worktree)?;

        // 6. Atomically update CURRENT.
        self.write_current_pointer(generation)?;

        // 7. Retain previous valid generation, clean stale tmp dirs.
        self.retain_previous(&final_dir, generation);

        Ok(manifest)
    }

    fn write_current_pointer(&self, generation: u64) -> std::io::Result<()> {
        let ptr = current_pointer(&self.worktree);
        let tmp_ptr = ptr.with_extension("tmp");
        {
            let mut f = std::fs::File::create(&tmp_ptr)?;
            f.write_all(generation.to_string().as_bytes())?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp_ptr, &ptr)?;
        sync_dir(&self.worktree)
    }

    /// Remove stale `.tmp` generations and keep at most `RETAIN_GENERATIONS`
    /// old generations (besides the just-published one).
    fn retain_previous(&self, published: &Path, generation: u64) {
        let _ = published;
        // Clean stale tmp dirs.
        if let Ok(entries) = std::fs::read_dir(&self.worktree) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(".tmp") {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
        // Keep newest RETAIN_GENERATIONS + the current one.
        let mut gens = self.persisted_generations();
        gens.retain(|g| *g != generation);
        gens.sort_unstable();
        gens.reverse();
        for old in gens.iter().skip(RETAIN_GENERATIONS) {
            let _ = std::fs::remove_dir_all(self.generation_path(*old));
        }
    }

    /// Move a corrupt generation into quarantine, retaining evidence.
    fn quarantine(&self, path: &Path, generation: u64, reason: &str) -> PathBuf {
        let qroot = quarantine_dir(&self.worktree);
        let _ = std::fs::create_dir_all(&qroot);
        let dst = qroot.join(format!("gen-{generation}-{}", sanitize(reason)));
        if std::fs::rename(path, &dst).is_err() {
            // Fallback: copy evidence marker alongside the original.
            let _ = std::fs::write(path.with_extension("corrupt"), format!("reason={reason}\n"));
            return path.to_path_buf();
        }
        // Write a diagnostic marker in quarantine.
        let _ = std::fs::write(
            dst.join("QUARANTINE.txt"),
            format!("reason={reason}\ngeneration={generation}\n"),
        );
        dst
    }
}

/// Whether the set of quarantined paths includes the generation that CURRENT
/// pointed at (meaning we need to repoint).
fn quarantined_was_current(quarantined: &[PathBuf], current: u64) -> bool {
    quarantined
        .iter()
        .any(|p| p.to_string_lossy().contains(&format!("gen-{current}")))
}

/// Read and validate a generation's manifest. Returns the manifest when the
/// generation is structurally valid (schema + checksums).
fn read_valid_manifest(path: &Path, generation: u64) -> std::io::Result<FdxIndexManifest> {
    let manifest_path = path.join(MANIFEST_FILE);
    let text = std::fs::read_to_string(&manifest_path).map_err(|e| {
        std::io::Error::new(
            e.kind(),
            format!("generation {generation}: missing/unreadable manifest: {e}"),
        )
    })?;
    let manifest: FdxIndexManifest = serde_json::from_str(&text).map_err(|e| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("generation {generation}: manifest parse error: {e}"),
        )
    })?;
    if manifest.generation != generation {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "generation {generation}: manifest claims generation {}",
                manifest.generation
            ),
        ));
    }
    if manifest.schema_version > INDEX_SCHEMA_VERSION {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "generation {generation}: unsupported schema {}",
                manifest.schema_version
            ),
        ));
    }
    verify_checksums(path, &manifest)?;
    Ok(manifest)
}

/// Verify every component checksum listed in the manifest.
fn verify_checksums(dir: &Path, manifest: &FdxIndexManifest) -> std::io::Result<()> {
    for (name, expected) in &manifest.checksums {
        let file = dir.join(name);
        let text = std::fs::read(&file).map_err(|e| {
            std::io::Error::new(
                e.kind(),
                format!("checksum: component {name} unreadable: {e}"),
            )
        })?;
        let actual = sha256_hex(&text);
        if actual != *expected {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("checksum mismatch for {name}: expected {expected}, got {actual}"),
            ));
        }
    }
    Ok(())
}

/// Compute the SHA-256 hex of bytes (used for component checksums).
pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(data);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Compute a checksum entry for a component file and register it in the
/// manifest. Returns the JSON-serialized value to store in the component
/// file, or an error.
pub fn write_component(
    dir: &Path,
    manifest: &mut FdxIndexManifest,
    name: &str,
    value: &serde_json::Value,
) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    let file = dir.join(name);
    {
        let mut f = std::fs::File::create(&file)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
    }
    manifest
        .checksums
        .insert(name.to_string(), sha256_hex(&bytes));
    Ok(())
}

/// Serialize a component value and write it + register its checksum.
/// Generic convenience wrapper around [`write_component`].
pub fn write_component_serde<T: serde::Serialize>(
    dir: &Path,
    manifest: &mut FdxIndexManifest,
    name: &str,
    value: &T,
) -> std::io::Result<()> {
    let json = serde_json::to_value(value).map_err(std::io::Error::other)?;
    write_component(dir, manifest, name, &json)
}

/// fsync a directory (best effort on platforms where it is unsupported).
pub fn sync_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let f = std::fs::File::open(dir)?;
        f.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
    Ok(())
}

/// Sanitize a reason string for use in a quarantine directory name.
fn sanitize(reason: &str) -> String {
    let mut out = String::new();
    for c in reason.chars().take(48) {
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push_str("corrupt");
    }
    out
}

/// Build a manifest that is fully "Ready" (all components present).
/// Used by tests and by the index service when a complete build succeeds.
pub fn ready_components(manifest: &mut FdxIndexManifest, ready: &[&str]) {
    for name in ready {
        let status = match *name {
            "files" => &mut manifest.components.files,
            "symbols" => &mut manifest.components.symbols,
            "dependencies" => &mut manifest.components.dependencies,
            "test_mapping" => &mut manifest.components.test_mapping,
            "git_state" => &mut manifest.components.git_state,
            "content_cache" => &mut manifest.components.content_cache,
            _ => continue,
        };
        *status = crate::index::manifest::ComponentStatus::Ready;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::manifest::{new_manifest, IndexIdentity};

    fn identity(name: &str) -> IndexIdentity {
        IndexIdentity {
            repository_id: format!("repo-{name}"),
            worktree_id: format!("wt-{name}"),
            repository_root_hash: format!("root-{name}"),
            repository_root: format!("/tmp/repo-{name}"),
            worktree_root: format!("/tmp/wt-{name}"),
        }
    }

    #[test]
    fn publish_and_reload_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("a");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();

        let manifest = store
            .publish(1, &ident, "0.1.0", "2026-01-01T00:00:00Z", |dir| {
                let mut m = new_manifest(
                    &ident,
                    "0.1.0",
                    1,
                    "2026-01-01T00:00:00Z",
                    "abc",
                    "dirty",
                    "cfg",
                    "ign",
                );
                let _ = write_component_serde(
                    dir,
                    &mut m,
                    "files.json",
                    &serde_json::json!([{"path": "a.txt"}]),
                );
                Ok(m)
            })
            .unwrap();

        assert_eq!(manifest.generation, 1);
        assert_eq!(store.current_generation().unwrap(), Some(1));

        // Reload: same store (same identity) should load gen 1.
        let store2 = GenerationStore::open(tmp.path(), &ident).unwrap();
        match store2.load() {
            LoadOutcome::Loaded(m) => {
                assert_eq!(m.generation, 1);
                assert_eq!(m.head_sha, "abc");
            }
            other => panic!("expected Loaded, got {other:?}"),
        }
    }

    #[test]
    fn different_worktrees_do_not_share_state() {
        let tmp = tempfile::tempdir().unwrap();
        let ident1 = identity("repo1");
        let ident2 = IndexIdentity {
            worktree_id: "wt-other".to_string(),
            ..ident1.clone()
        };
        let store1 = GenerationStore::open(tmp.path(), &ident1).unwrap();
        store1
            .publish(1, &ident1, "0.1.0", "t", |dir| {
                let mut m = new_manifest(&ident1, "0.1.0", 1, "t", "abc", "d", "c", "i");
                let _ = write_component_serde(dir, &mut m, "files.json", &serde_json::json!([]));
                Ok(m)
            })
            .unwrap();
        let store2 = GenerationStore::open(tmp.path(), &ident2).unwrap();
        assert!(matches!(store2.load(), LoadOutcome::Empty));
    }

    #[test]
    fn corrupt_generation_is_quarantined_and_prior_retained() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("corrupt");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        // gen 1 valid
        store
            .publish(1, &ident, "0.1.0", "t", |dir| {
                let mut m = new_manifest(&ident, "0.1.0", 1, "t", "h1", "d", "c", "i");
                let _ = write_component_serde(dir, &mut m, "files.json", &serde_json::json!([]));
                Ok(m)
            })
            .unwrap();
        // gen 2 corrupt: write a manifest with a wrong checksum
        let gen2 = store.generation_path(2);
        std::fs::create_dir_all(&gen2).unwrap();
        let mut m = new_manifest(&ident, "0.1.0", 2, "t", "h2", "d", "c", "i");
        m.checksums
            .insert("files.json".to_string(), "deadbeef".to_string());
        std::fs::write(
            gen2.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();
        std::fs::write(gen2.join("files.json"), b"[]").unwrap();
        store.write_current_pointer(2).unwrap();

        match store.load() {
            LoadOutcome::Loaded(m) => {
                assert_eq!(m.generation, 1, "should fall back to gen 1");
            }
            other => panic!("expected fallback load, got {other:?}"),
        }
        // CURRENT repointed to 1
        assert_eq!(store.current_generation().unwrap(), Some(1));
        // quarantine dir has evidence
        let q = quarantine_dir(store.worktree_path());
        assert!(q.exists());
    }

    #[test]
    fn future_schema_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("future");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        // Manually write a gen with schema 999.
        let gen = store.generation_path(1);
        std::fs::create_dir_all(&gen).unwrap();
        let mut m = new_manifest(&ident, "0.1.0", 1, "t", "h", "d", "c", "i");
        m.schema_version = 999;
        std::fs::write(
            gen.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&m).unwrap(),
        )
        .unwrap();
        store.write_current_pointer(1).unwrap();

        // load() quarantines it (schema > supported => invalid), returns Empty/Corrupt.
        match store.load() {
            LoadOutcome::Empty => {}
            LoadOutcome::Corrupt { .. } => {}
            other => panic!("expected Empty/Corrupt for future schema, got {other:?}"),
        }

        // publish() must reject the future schema too.
        let err = store
            .publish(2, &ident, "0.1.0", "t", |dir| {
                let mut m = new_manifest(&ident, "0.1.0", 2, "t", "h", "d", "c", "i");
                m.schema_version = 999;
                let _ = write_component_serde(dir, &mut m, "files.json", &serde_json::json!([]));
                Ok(m)
            })
            .unwrap_err();
        assert!(err.to_string().contains("newer than supported"));
    }

    #[test]
    fn stale_tmp_generations_are_cleaned() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("tmpclean");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        // Create a stale tmp dir
        let stale = store.worktree_path().join("gen-99.tmp");
        std::fs::create_dir_all(&stale).unwrap();
        std::fs::write(stale.join("x"), b"y").unwrap();

        store
            .publish(1, &ident, "0.1.0", "t", |dir| {
                let mut m = new_manifest(&ident, "0.1.0", 1, "t", "h", "d", "c", "i");
                let _ = write_component_serde(dir, &mut m, "files.json", &serde_json::json!([]));
                Ok(m)
            })
            .unwrap();

        assert!(!store.worktree_path().join("gen-99.tmp").exists());
    }

    #[test]
    fn retained_previous_generation_keeps_last_valid() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("retain");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        for g in [1, 2, 3] {
            store
                .publish(g, &ident, "0.1.0", "t", |dir| {
                    let mut m =
                        new_manifest(&ident, "0.1.0", g, "t", &format!("h{g}"), "d", "c", "i");
                    let _ = write_component_serde(
                        dir,
                        &mut m,
                        "files.json",
                        &serde_json::json!([{"g": g}]),
                    );
                    Ok(m)
                })
                .unwrap();
        }
        let gens = store.persisted_generations();
        assert!(gens.contains(&3), "current gen present: {gens:?}");
        assert!(gens.contains(&2), "previous valid retained: {gens:?}");
        assert!(!gens.contains(&1), "older than retention dropped: {gens:?}");
        assert_eq!(store.current_generation().unwrap(), Some(3));
    }

    #[test]
    fn component_checksum_detects_tampering() {
        let tmp = tempfile::tempdir().unwrap();
        let ident = identity("tamper");
        let store = GenerationStore::open(tmp.path(), &ident).unwrap();
        store
            .publish(1, &ident, "0.1.0", "t", |dir| {
                let mut m = new_manifest(&ident, "0.1.0", 1, "t", "h", "d", "c", "i");
                let _ = write_component_serde(
                    dir,
                    &mut m,
                    "files.json",
                    &serde_json::json!([{"path": "a"}]),
                );
                Ok(m)
            })
            .unwrap();
        // Tamper with the component file after publish.
        let mut f = std::fs::File::create(store.generation_path(1).join("files.json")).unwrap();
        f.write_all(br#"[{"path":"tampered"}]"#).unwrap();
        f.sync_all().unwrap();

        match store.load() {
            LoadOutcome::Corrupt { .. } => {}
            LoadOutcome::Empty => {}
            other => panic!("expected corrupt load, got {other:?}"),
        }
    }
}
