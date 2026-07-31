import { describe, it, expect } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

/**
 * Regression test for failed publish run 30640413645.
 *
 * Root cause: publish.yml ran "Run Tests" (npm test) BEFORE "Build Package"
 * (npm run build). On a fresh tag checkout no dist/index.js exists, so the
 * packed-doctor tests (tests/doctor-packed.test.ts, copyDist) hard-fail.
 * ci.yml builds first, so the tag-triggered publish workflow ordering bug
 * was never caught by PR checks.
 *
 * Contract this test enforces:
 *   - the publish job has a "Build Package" step
 *   - the publish job has a "Run Tests" step
 *   - "Build Package" appears BEFORE "Run Tests" in the ordered step list
 */
const publishYmlPath = join(process.cwd(), ".github", "workflows", "publish.yml")

function extractStepNames(content: string): string[] {
  const lines = content.split("\n")
  const names: string[] = []

  // Locate the steps block of the first job under `jobs:`
  const jobsIndex = lines.findIndex((line) => /^\s*jobs:\s*$/.test(line))
  if (jobsIndex === -1) return names

  const stepsIndex = lines.findIndex(
    (line, i) => i > jobsIndex && /^\s+steps:\s*$/.test(line)
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

describe("publish.yml workflow step ordering", () => {
  it("publish.yml runs a build step before the test step", () => {
    const content = readFileSync(publishYmlPath, "utf-8")
    const stepNames = extractStepNames(content)

    const buildIndex = stepNames.indexOf("Build Package")
    const testIndex = stepNames.indexOf("Run Tests")

    // Guards: the parse must find both steps (fail loudly, not silently).
    expect(buildIndex).toBeGreaterThan(-1)
    expect(testIndex).toBeGreaterThan(-1)

    // The contract that fixes the root cause: build must run before tests,
    // because the packed-doctor tests depend on dist/index.js.
    expect(buildIndex).toBeLessThan(testIndex)
  })

  it("publish.yml retains the npm publish step", () => {
    const content = readFileSync(publishYmlPath, "utf-8")
    const stepNames = extractStepNames(content)
    expect(stepNames).toContain("Publish to npm")
  })
})
