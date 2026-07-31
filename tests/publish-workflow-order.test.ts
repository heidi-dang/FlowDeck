import { describe, it, expect } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

/**
 * Release-workflow regression coverage for .github/workflows/publish.yml.
 *
 * Regression test for failed publish run 30640413645.
 *
 * Root cause: publish.yml ran "Run Tests" (npm test) BEFORE "Build Package"
 * (npm run build). On a fresh tag checkout no dist/index.js exists, so the
 * packed-doctor tests (tests/doctor-packed.test.ts, copyDist) hard-fail.
 * ci.yml builds first, so the tag-triggered publish workflow ordering bug
 * was never caught by PR checks.
 *
 * These tests MUST fail against the v1.0.1 release workflow and pass against
 * the v1.0.2 workflow:
 *   1. Install dependencies precedes build.
 *   2. Typecheck precedes publish.
 *   3. Build precedes tests.
 *   4. Tests precede publish.
 *   5. Package validation precedes publish.
 *   6. Bun is pinned to 1.3.14.
 *   7. Tag/package version alignment exists.
 *   8. Registry version-availability validation exists.
 *   9. npm provenance remains enabled.
 *   10. Publish runs only for version tags.
 *   11. No `|| true` masks release failures.
 */
const publishYmlPath = join(process.cwd(), ".github", "workflows", "publish.yml")

function readWorkflow(): string {
  return readFileSync(publishYmlPath, "utf-8")
}

function extractStepNames(content: string): string[] {
  const lines = content.split("\n")
  const names: string[] = []

  // Locate the steps block of the first job under `jobs:`
  const jobsIndex = lines.findIndex((line) => /^\s*jobs:\s*$/.test(line))
  if (jobsIndex === -1) return names

  const stepsIndex = lines.findIndex(
    (line, i) => i > jobsIndex && /^\s+steps:\s*$/.test(line),
  )
  if (stepsIndex === -1) return names

  const stepsIndent = lines[stepsIndex].match(/^\s*/)![0].length
  for (let i = stepsIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "" || /^\s*#/.test(line)) continue
    const indent = line.match(/^\s*/)![0].length
    if (indent <= stepsIndent) break // left the steps block
    const match = line.match(/^\s*-\s*name:\s*(.+?)\s*$/)
    if (match) names.push(match[1])
  }
  return names
}

/**
 * Ordered-position helper: assert that `before` step runs before `after`.
 */
function expectStepOrder(stepNames: string[], before: string, after: string) {
  const beforeIndex = stepNames.indexOf(before)
  const afterIndex = stepNames.indexOf(after)
  expect(beforeIndex, `${before} step must exist`).toBeGreaterThan(-1)
  expect(afterIndex, `${after} step must exist`).toBeGreaterThan(-1)
  expect(beforeIndex, `${before} must run before ${after}`).toBeLessThan(afterIndex)
}

describe("publish.yml workflow step ordering", () => {
  const content = readWorkflow()
  const stepNames = extractStepNames(content)

  it("1. install dependencies precedes build", () => {
    expectStepOrder(stepNames, "Install Dependencies", "Build Package")
  })

  it("2. typecheck precedes publish", () => {
    expectStepOrder(stepNames, "Typecheck", "Publish to npm")
  })

  it("3. build precedes tests", () => {
    expectStepOrder(stepNames, "Build Package", "Run Tests")
  })

  it("4. tests precede publish", () => {
    expectStepOrder(stepNames, "Run Tests", "Publish to npm")
  })

  it("5. package validation precedes publish", () => {
    expectStepOrder(stepNames, "Validate Package", "Publish to npm")
  })

  it("6. bun is pinned to 1.3.14", () => {
    // The v1.0.1 workflow used an unpinned `oven-sh/setup-bun@v2` with no
    // bun-version, allowing test behaviour to drift between releases.
    expect(content).toMatch(/bun-version:\s*"1\.3\.14"/)
  })

  it("7. tag/version alignment validation exists", () => {
    expect(stepNames).toContain("Validate Tag/Version Alignment")
    // Must compare GITHUB_REF_NAME (tag) with package.json version and fail.
    expect(content).toContain("GITHUB_REF_NAME")
    expect(content).toContain('require(\'./package.json\').version')
    expect(content).toMatch(/if \[\s*"\$TAG_VERSION"\s*!=\s*"\$PKG_VERSION"\s*\]/)
  })

  it("8. registry version-availability validation exists", () => {
    expect(stepNames).toContain("Check Registry Availability")
    // A duplicate-version publish attempt must be blocked, and lookup
    // failures must not be hidden.
    expect(content).toContain('npm view')
    expect(content).toContain("already exists")
    expect(content).not.toContain("2>/dev/null")
  })

  it("9. npm provenance remains enabled", () => {
    // The publish command must keep --provenance and the id-token permission.
    expect(content).toContain("npm publish --provenance --access public")
    expect(content).toMatch(/id-token:\s*write/)
    expect(content).not.toContain("npm publish --access public\n") // bare publish without provenance
  })

  it("10. publish runs only for version tags", () => {
    // Trigger must be a tag push (v*), not branches or pull_request.
    expect(content).toMatch(/^on:\s*$/m)
    expect(content).toMatch(/push:/)
    expect(content).toMatch(/tags:/)
    expect(content).toMatch(/-\s*"v\*"/)
    // The workflow must not trigger on branch pushes or PRs.
    expect(content).not.toMatch(/pull_request:/)
    expect(content).not.toMatch(/^on:\s*\n\s+branches:/m)
  })

  it("11. no '|| true' masks release failures", () => {
    // Any `|| true` in the publish workflow would swallow a failing step and
    // could publish a broken package.
    expect(content).not.toMatch(/\|\|\s*true/)
  })
})
