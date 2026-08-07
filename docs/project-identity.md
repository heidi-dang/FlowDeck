# Canonical Project Identity Algorithm (v1)

The project identity (`~/.fd-plan/<project-id>/` directory name, FDX index
identity inputs, cache keys) is derived from the repository root directory path
by ONE canonical algorithm. There are exactly two implementations, and both
must produce byte-identical output for identical input:

| Implementation | Location |
|----------------|----------|
| TypeScript     | `src/tools/planning-state-lib.ts` — `normalizePathForId` / `generateProjectId` |
| Rust           | `crates/fdx/src/paths.rs` — `normalize_path_for_id` / `generate_project_id` |

Expected outputs are pinned in the versioned fixture
`fixtures/fdx/project-identity-v1.json`, which both implementations' tests
consume. Changing a pinned output is a breaking change and requires bumping the
fixture `algorithm_version` (and a deliberate migration decision for existing
cache/index directories).

## Steps

Given the caller-provided directory path `P` and the process current working
directory `C`:

1. **Separator normalization**: replace every `\` with `/`.
2. **Extended-length prefix**: if the result starts with `//?/` or `\\?\`,
   strip that 4-character prefix.
3. **Drive letter**: if the result matches `^[A-Za-z]:`, uppercase the letter
   (`c:` → `C:`).
4. **Relative resolution**: if the result is not absolute (no leading `/`, no
   drive path, not a UNC path), join it to `C`.
5. **Filesystem canonicalization** (only when the path exists AND it is not a
   UNC path):
   - TypeScript: `fs.realpathSync.native` (libuv), falling back to
     `fs.realpathSync` — resolves symlinks and Windows 8.3 short names
     (`RUNNER~1` → the long name) identically to Rust's `std::fs::canonicalize`.
   - Rust: `std::fs::canonicalize`, then strip the `\\?\` prefix that Windows
     returns.
   - UNC paths are canonical as given: no symlink/short-name resolution on
     network shares.
6. **Lexical normalization** (nonexistent paths): collapse repeated `/`
   (preserving a leading `//` for UNC), drop `.` segments, resolve `..` against
   the preceding segment, and drop a `..` that would climb above the root or a
   drive prefix (`/..` → `/`). This mirrors `path.resolve` on every platform.
7. **Trailing separator**: strip one trailing `/` when the result is longer
   than 3 characters (preserving `/` and `C:/` roots).
8. **Drive letter again**: repeat step 3 on the final result.

## Identity

```
id = "<basename-of-canonical>[-]<8 hex chars of sha256(canonical)>"
```

- The basename is the last path segment; root (`/`) and drive-root (`C:/`)
  inputs have an empty basename and yield `-<hash>` in both implementations
  (TypeScript aligns `C:/` with Rust's empty `file_name`).
- No general case folding (only the drive letter is uppercased), no Unicode
  normalization (NFC and NFD inputs produce different ids), no hostname or
  username resolution, no machine-specific path components.

## Explicit behaviors

| Case | Behavior |
|------|----------|
| Slash direction | `\` and `/` are equivalent input separators on all platforms |
| Repeated separators | collapsed (`/a//b` ≡ `/a/b`) |
| Trailing separator | stripped beyond the root |
| `.` / `..` | resolved lexically; `..` above root is dropped |
| Relative paths | resolved against the process cwd |
| Drive letter | uppercased; `C:` vs `D:` produce different ids |
| UNC (`//server/share`) | preserved as `//server/share`; no resolution; not joined to cwd |
| `\\?\` prefix | stripped |
| Symlinks | resolved to the physical target when the path exists (not for UNC) |
| 8.3 short names (Windows) | resolved to the long name (both implementations) |
| Case folding | none beyond the drive letter |
| Unicode | none (byte-for-byte hashing) |
| Reserved Windows names | hashed verbatim; no collision handling beyond the 8-hex hash |
| Cache compatibility | changing `algorithm_version` orphans old ids — migrate existing
  `~/.fd-plan/<old-id>` directories or keep the old version discoverable |

## Changing the algorithm

1. Bump `algorithm_version` in `fixtures/fdx/project-identity-v1.json`.
2. Update the pinned `canonical`/`expected_id` values in both platform columns.
3. Update both implementations to the new rules.
4. Decide and document the migration for existing cache/index directories.
5. Run both fixture tests and the cross-runtime byte-parity test.
