/**
 * Test preload: ensures the `fdx-secure-exec` native helper is built before
 * the FDX test suites run.
 *
 * The helper is the ONLY secure process-creation path (Blocker 1): the
 * verified-execution pipeline streams the validated bytes to it and it
 * materializes them in a platform-immutable object (sealed memfd on Linux,
 * unlinked descriptor on macOS, share-denied handle on Windows). Without it
 * native execution is refused, so tests that exercise the resolver / probe /
 * command paths need it present.
 *
 * The crate (crates/fdx/src/bin/fdx-secure-exec.rs) has zero dependencies and
 * compiles in a few seconds; cargo caches it, so only the first run pays the
 * build cost. CI runners and dev machines have cargo installed.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"

const repoRoot = join(import.meta.dir, "..")
const helperName = process.platform === "win32" ? "fdx-secure-exec.exe" : "fdx-secure-exec"
const releaseBin = join(repoRoot, "target", "release", helperName)
const debugBin = join(repoRoot, "target", "debug", helperName)

if (!existsSync(releaseBin) && !existsSync(debugBin)) {
  execFileSync(
    "cargo",
    ["build", "--release", "--bin", "fdx-secure-exec", "--manifest-path", join(repoRoot, "crates", "fdx", "Cargo.toml")],
    { cwd: repoRoot, stdio: "inherit" },
  )
  if (!existsSync(releaseBin)) {
    throw new Error("fdx-secure-exec helper build failed: target/release/fdx-secure-exec missing")
  }
}
