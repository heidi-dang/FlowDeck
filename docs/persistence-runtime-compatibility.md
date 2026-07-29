# Persistence Runtime Compatibility

## Current Status: bun:sqlite

- **Runtime**: All persistence operations run on `bun:sqlite` (Bun's built-in SQLite driver)
- **Driver**: `bun:sqlite` — no native addon compilation, no `node-gyp` dependency
- **Compatibility**: Works on all platforms Bun supports (macOS, Linux, Windows)

## Architecture

The persistence layer uses Bun's native `bun:sqlite` module directly:

```typescript
import { Database } from "bun:sqlite"
```

Key differences from `better-sqlite3`:
- Constructor: `new Database(path, { create: true })` instead of `new Database(path)`
- Pragma read: `db.query("PRAGMA ...").get()` instead of `db.pragma()`
- Pragma set: `db.run("PRAGMA ... = ...")` instead of `db.pragma("... = ...")`
- Boolean pragma values: returned as integers (1/0) instead of strings ("on"/"off")

## Bundled — No Extra Dependencies

`bun:sqlite` is included with the Bun runtime. No additional npm packages or native addons are required.
