/**
 * Lazy bun:sqlite loader.
 *
 * `bun:sqlite` is a Bun runtime builtin. A static top-level
 * `import { Database } from "bun:sqlite"` in a bundle compiled with
 * `--target node` is kept as a bare `bun:` import, which the Node ESM
 * loader rejects at module-load time (ERR_UNSUPPORTED_ESM_URL_SCHEME).
 *
 * To keep the packed standalone CLI loadable under supported Node versions
 * (the `dist/better-harness/standalone.js` bundle), the Database class is
 * acquired lazily via `createRequire` at the point of first use instead of
 * at import time. Under Bun the require resolves normally; under Node the
 * module loads cleanly and only an explicit database construction fails
 * with the underlying "Cannot find module 'bun:sqlite'" error — acceptable
 * because the standalone CLI's help path and server lifecycle never open a
 * SQLite handle.
 */

import { createRequire } from "node:module";
import type { Database } from "bun:sqlite";

const require = createRequire(import.meta.url);

let _Database: typeof Database | undefined;

/**
 * Returns the bun:sqlite Database class, loading it on first use.
 * @throws if bun:sqlite is unavailable in the current runtime.
 */
export function loadBunSqliteDatabase(): typeof Database {
  if (!_Database) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("bun:sqlite") as { Database: typeof Database };
    _Database = mod.Database;
  }
  return _Database;
}
