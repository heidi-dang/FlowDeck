# Persistence Runtime Compatibility

## Supported Production Runtime
- **Node.js** >= 18.0.0 (primary, tested)
- **Runtime**: All persistence operations run on `better-sqlite3` which compiles via `node-gyp`

## Supported Test Runtime
- **Node.js** >= 18.0.0 (all tests pass)
- **bun** 1.3.14: Unit tests without native module dependencies pass
- **bun + better-sqlite3**: Observed compatibility failure (see below)

## Known Bun Limitation

### Observed Compatibility Failure
When running `bun test` with the `better-sqlite3` native addon, bun crashes with:
```
panic(main thread): NAPI FATAL ERROR: Error::New napi_get_last_error_info
```
This occurs in bun v1.3.14 on Windows (including WSL2). The crash happens during NAPI lifecycle management when loading the `better-sqlite3` native Node.js addon.

### Affected Environments
| Environment | Status |
|------------|--------|
| Node.js (all platforms) | ✅ Fully supported |
| bun on macOS | ✅ Works (native NAPI support) |
| bun on Linux (native) | ✅ Works |
| bun on Windows/WSL2 | ❌ Observed crash |
| bun on Windows (native) | ❌ Observed crash |

### Reproduction
```bash
npm install better-sqlite3
bun test src/orchestration/persistence/__tests__/persistence.test.ts
# Panic: NAPI FATAL ERROR
```

### Recommended Runtime
- **Development**: Node.js >= 18.0.0
- **CI**: Node.js >= 18.0.0 (cross-platform matrix)
- **Production**: Node.js >= 18.0.0

### Fallback Decision
A pure-JS SQLite driver (`sql.js`) is **not** included in this PR. Adding a driver abstraction layer is deferred until cross-runtime compatibility becomes an explicit requirement. The current `better-sqlite3` dependency is the standard choice for Node.js SQLite access in the npm ecosystem.
