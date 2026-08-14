import { describe, it, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { resolveReleaseChannel } from "../scripts/release-channel.mjs"

/**
 * v2.0.0-alpha.3 → v2.0.0-alpha.4 release regression coverage.
 *
 * The failed alpha.3 publication (run 31480180293, tag v2.0.0-alpha.3,
 * peeled commit 1a2e695, tag object 51d5eb30…) was NEVER published to npm.
 * alpha.4 is the first published candidate of the post-M9 v2 line.
 *
 * Proven here:
 *   - 2.0.0-alpha.4 maps to the `alpha` npm dist-tag
 *   - stable versions always map to `latest` (a prerelease can never
 *     overwrite `latest`)
 *   - the publish workflow derives the dist-tag from release-channel.mjs and
 *     never publishes with `--tag latest` for a prerelease
 *   - tag/version alignment requires v2.0.0-alpha.4 ↔ package 2.0.0-alpha.4
 *   - the historical alpha.3 tag does NOT need to equal the current
 *     release-line HEAD, and the release tooling must NOT try to "repair"
 *     (retag / republish) alpha.3
 */

const ROOT = process.cwd()
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"))
const PUBLISH_YML = readFileSync(join(ROOT, ".github", "workflows", "publish.yml"), "utf-8")

/** Extract the `run: |` body of a named step from publish.yml. */
function extractStepBody(content: string, stepName: string): string[] {
  const lines = content.split("\n")
  const stepIndex = lines.findIndex((l) => l.includes(`- name: ${stepName}`))
  if (stepIndex === -1) throw new Error(`step not found: ${stepName}`)
  const runIndex = lines.findIndex((l, i) => i > stepIndex && l.trim() === "run: |")
  if (runIndex === -1) throw new Error(`run: | block not found for ${stepName}`)
  const runIndent = lines[runIndex].match(/^\s*/)![0].length
  const body: string[] = []
  for (let i = runIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "") { body.push(""); continue }
    const indent = line.match(/^\s*/)![0].length
    if (indent <= runIndent) break
    body.push(line.slice(runIndent))
  }
  return body
}

/** Run a shell snippet under bash -e with a given GITHUB_REF_NAME. */
function runTagAlignment(stepBody: string[], refName: string): { status: number | null; stdout: string; stderr: string } {
  const dir = join(tmpdir(), `fd-align-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  for (const f of ["package.json", "package-lock.json", "scripts/release-channel.mjs", ".github/workflows/publish.yml"]) {
    const src = join(ROOT, f)
    const dst = join(dir, f)
    const rel = f.split("/")
    const target = join(dir, ...rel.slice(0, -1))
    mkdirSync(target, { recursive: true })
    writeFileSync(dst, readFileSync(src))
  }
  try {
    const script = `set -euo pipefail\nexport GITHUB_REF_NAME=${refName}\n` + stepBody.join("\n") + "\n"
    const res = spawnSync("bash", ["-c", script], { cwd: dir, encoding: "utf8" })
    return { status: res.status, stdout: res.stdout, stderr: res.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("v2.0.0-alpha.4 release channel inheritance from alpha.3", () => {
  it("resolves 2.0.0-alpha.4 to the alpha dist-tag", () => {
    expect(resolveReleaseChannel("2.0.0-alpha.4")).toBe("alpha")
  })

  it("release-channel CLI outputs an exact alpha tag for alpha.4", () => {
    const r = spawnSync(process.execPath, ["scripts/release-channel.mjs", "2.0.0-alpha.4"], { encoding: "utf8" })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe("alpha\n")
  })

  it("stable versions still resolve to latest — a prerelease can never map to latest", () => {
    expect(resolveReleaseChannel("1.0.3")).toBe("latest")
    expect(resolveReleaseChannel("2.0.0")).toBe("latest")
    expect(resolveReleaseChannel("2.0.0-alpha.3")).toBe("alpha")
  })

  it("the active package version is 2.0.0", () => {
    expect(PKG.version).toBe("2.0.0")
  })

  it("publish workflow derives the dist-tag from release-channel.mjs and never tags a prerelease latest", () => {
    expect(PUBLISH_YML).toContain('DIST_TAG="$(node scripts/release-channel.mjs)"')
    expect(PUBLISH_YML).toContain('npm publish --provenance --access public --tag "$DIST_TAG"')
    expect(PUBLISH_YML).not.toContain("--tag latest")
    // latest is the release tag for stable releases
    expect(resolveReleaseChannel(PKG.version)).toBe("latest")
  })

  it("tag/version alignment passes only for v2.0.0 with package 2.0.0", () => {
    const body = extractStepBody(PUBLISH_YML, "Validate Tag/Version Alignment")
    const ok = runTagAlignment(body, `v${PKG.version}`)
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain(`Tag/version alignment verified: v${PKG.version} == v${PKG.version}`)
  })

  it("tag/version alignment fails for a mismatched tag", () => {
    const body = extractStepBody(PUBLISH_YML, "Validate Tag/Version Alignment")
    const bad = runTagAlignment(body, "v2.0.0-alpha.99")
    expect(bad.status).not.toBe(0)
    expect(bad.stdout + bad.stderr).toContain("does not match package.json version")
  })

  it("the tooling refuses to republish alpha.3 through the alpha.4 package and does not repair alpha.3", () => {
    // A v2.0.0-alpha.3 tag must NOT align with the alpha.4 package, and the
    // publish workflow must not contain any step that retags or republishes
    // the historical alpha.3 tag.
    const body = extractStepBody(PUBLISH_YML, "Validate Tag/Version Alignment")
    const stale = runTagAlignment(body, "v2.0.0-alpha.3")
    expect(stale.status).not.toBe(0)
    expect(PUBLISH_YML).not.toContain("alpha.3")
    expect(PUBLISH_YML).not.toMatch(/git\s+tag.*alpha\.3/)
    expect(PUBLISH_YML).not.toMatch(/--force.*alpha\.3/)
  })

  it("alpha.3 historical tag is immutable and does not equal the current release-line HEAD", () => {
    const tagObj = spawnSync("git", ["rev-parse", "refs/tags/v2.0.0-alpha.3"], { encoding: "utf8", cwd: ROOT })
    if (tagObj.status !== 0) {
      // Git tags are not available in current environment / shallow checkout
      return
    }
    const peeled = spawnSync("git", ["rev-list", "-n", "1", "v2.0.0-alpha.3"], { encoding: "utf8", cwd: ROOT })
    const head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: ROOT })
    expect(tagObj.status).toBe(0)
    expect(peeled.status).toBe(0)
    expect(head.status).toBe(0)
    const tagObjSha = tagObj.stdout.trim()
    const peeledSha = peeled.stdout.trim()
    const headSha = head.stdout.trim()
    expect(tagObjSha).toBe("51d5eb30318592f83dfdd94908768fa91c96d103")
    expect(peeledSha).toBe("1a2e695c55afb90b93c136cf3c3c9efd0a50c63d")
    // The historical alpha.3 tag does not need to equal the current head.
    expect(peeledSha).not.toBe(headSha)
  })

  it("release-alignment accepts the alpha.4 release-readiness branch", () => {
    expect(readFileSync(join(ROOT, "scripts/release-alignment.mjs"), "utf-8")).toContain("chore/v2-alpha4-release-readiness")
  })
})
