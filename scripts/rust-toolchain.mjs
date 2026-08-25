import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"

/** @typedef {(executable: string, args: string[], options: object) => string} ExecFile */

/** @param {string} executable @param {string[]} args @param {ExecFile} execFile */
function run(executable, args, execFile) {
  return execFile(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function versionPair(cargoVersion, rustcVersion) {
  const cargo = cargoVersion.match(/cargo (\d+\.\d+)/)?.[1]
  const rustc = rustcVersion.match(/rustc (\d+\.\d+)/)?.[1]
  if (!cargo || !rustc || cargo !== rustc) {
    throw new Error(`Rust toolchain mismatch: ${cargoVersion}; ${rustcVersion}`)
  }
  return { cargoVersion, rustcVersion }
}

function rustupCandidates(env, platform) {
  const executable = platform === "win32" ? "rustup.exe" : "rustup"
  const candidates = []
  if (env.RUSTUP) candidates.push(env.RUSTUP)
  if (env.CARGO_HOME) candidates.push(join(env.CARGO_HOME, "bin", executable))
  const home = env.USERPROFILE || env.HOME
  if (home) candidates.push(join(home, ".cargo", "bin", executable))
  candidates.push(executable)
  return [...new Set(candidates)]
}

/**
 * Select one Cargo/Rustc pair for all repository Rust invocations.
 * Explicit CARGO/RUSTC overrides win; otherwise the active Rustup toolchain is
 * used when available, then the process PATH is the fail-closed fallback.
 */
/**
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, execFile?: ExecFile, exists?: (path: string) => boolean }} [options]
 */
export function resolveRustToolchain({
  env = process.env,
  platform = process.platform,
  execFile = /** @type {ExecFile} */ (execFileSync),
  exists = existsSync,
} = {}) {
  let cargo = env.CARGO || ""
  let rustc = env.RUSTC || ""

  if (!cargo || !rustc) {
    for (const candidate of rustupCandidates(env, platform)) {
      if (candidate.includes("/") || candidate.includes("\\")) {
        if (!exists(candidate)) continue
      }
      try {
        const resolvedCargo = run(candidate, ["which", "cargo"], execFile)
        const resolvedRustc = run(candidate, ["which", "rustc"], execFile)
        if (resolvedCargo && resolvedRustc) {
          cargo ||= resolvedCargo
          rustc ||= resolvedRustc
          break
        }
      } catch {
        // Try the next Rustup location or PATH fallback.
      }
    }
  }

  cargo ||= "cargo"
  rustc ||= "rustc"
  const { cargoVersion, rustcVersion } = versionPair(
    run(cargo, ["--version"], execFile),
    run(rustc, ["--version"], execFile),
  )
  const toolchainEnv = {
    ...env,
    CARGO: cargo,
    RUSTC: rustc,
    PATH: `${dirname(cargo)}${delimiter}${env.PATH || ""}`,
  }
  return { cargo, rustc, cargoVersion, rustcVersion, env: toolchainEnv }
}
