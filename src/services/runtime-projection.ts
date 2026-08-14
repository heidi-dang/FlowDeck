import { execFileSync } from "node:child_process"
import { platform, arch, cwd, execPath } from "node:process"

function version(command: string, args: string[]): string {
  try { return execFileSync(command, args, { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0].slice(0, 120) }
  catch { return "unavailable" }
}

/** A bounded, non-sensitive environment summary for delegated children. */
export function buildRuntimeProjection(workspace = cwd()): string {
  const bun = version("bun", ["--version"])
  const npm = version("npm", ["--version"])
  const node = version(execPath, ["--version"])
  const git = version("git", ["--version"])
  const fdx = version("fdx", ["--version"])
  return [
    `workspace: ${workspace}`,
    `os: ${platform}/${arch}`,
    `node: ${node} (${execPath})`,
    `npm: ${npm}`,
    `bun: ${bun}`,
    `git: ${git}`,
    `fdx: ${fdx}`,
    "package-manager: npm (bun available for repository scripts)",
  ].join("\n")
}
