import { describe, it, expect } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

const ROOT = process.cwd()
const CI_WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml")

/**
 * Extract the YAML mapping block for a top-level key (job or job-level
 * mapping entry) as a list of (key, value) pairs with their raw lines.
 *
 * This is a minimal line-oriented extractor for the specific workflow
 * structure under test: it does not fully parse YAML, but it does resolve
 * key/value pairs inside a given block instead of counting string matches.
 */
function extractBlockLines(content: string, topKey: string): string[] {
  // Normalize CRLF to LF so exact key matches work on Windows checkouts.
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const topIndex = lines.findIndex((l) => l === topKey || l.startsWith(topKey + " "))
  if (topIndex === -1) return []
  const topIndent = topKey.length - topKey.trimStart().length
  const block: string[] = []
  for (let i = topIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "" || line.trim().startsWith("#")) continue
    const indent = line.length - line.trimStart().length
    if (indent <= topIndent) break
    block.push(line)
  }
  return block
}

/** Parse block lines into [indent, key, value] triples, preserving nesting. */
function parseBlock(blockLines: string[]): Array<{ indent: number; key: string; value: string }> {
  return blockLines.map((line) => {
    const normalized = line.replace(/\r$/, "")
    const indent = normalized.length - normalized.trimStart().length
    const trimmed = normalized.trim()
    const colon = trimmed.indexOf(":")
    if (colon === -1) return { indent, key: trimmed, value: "" }
    return { indent, key: trimmed.slice(0, colon).trim(), value: trimmed.slice(colon + 1).trim() }
  })
}

const CANDIDATE_EXPR = "${{ github.event.pull_request.head.sha || github.sha }}"
const BASELINE_SHA = "e22e04b38e45405b4ae9f15115012d0dce99c241"

describe("Phase 8 — CI Workflow Contract (benchmark binds to PR head SHA)", () => {
  it("ci.yml exists", () => {
    expect(existsSync(CI_WORKFLOW)).toBe(true)
  })

  it("benchmark job exists and Pipeline Completion requires it", () => {
    const content = readFileSync(CI_WORKFLOW, "utf-8")
    const jobEntries = parseBlock(extractBlockLines(content, "jobs:"))
    expect(jobEntries.some((e) => e.key === "benchmark-runtime")).toBe(true)

    // Pipeline Completion is the `completion` job under jobs:; its needs
    // list must require benchmark-runtime.
    const completionBlock = extractBlockLines(content, "  completion:")
    const needsLines = completionBlock.filter((l) => l.includes("needs:"))
    const completionNeeds = needsLines.join("\n")
    expect(completionNeeds).toContain("benchmark-runtime")
  })

  it("benchmark job checkouts the explicit resolved candidate ref", () => {
    const content = readFileSync(CI_WORKFLOW, "utf-8")
    const jobBlock = extractBlockLines(content, "  benchmark-runtime:")
    const entries = parseBlock(jobBlock)

    // Job-level env.CANDIDATE_SHA binds one canonical expression.
    const envEntries = entries.filter((e) => e.key === "env")
    expect(envEntries.length).toBeGreaterThan(0)
    // Find CANDIDATE_SHA inside the job env block lines
    const envLines = jobBlock.filter((l) => /^\s+env:/.test(l) || /^\s+CANDIDATE_SHA:/.test(l))
    const candidateEnv = envLines.find((l) => /^\s+CANDIDATE_SHA:/.test(l)) ?? ""
    expect(candidateEnv).toContain(CANDIDATE_EXPR)
    expect(candidateEnv).not.toContain("${{ github.sha }}")

    // Checkout step uses an explicit ref bound to the same expression.
    const checkoutLines = jobBlock.filter((l) => l.includes("actions/checkout@v4"))
    expect(checkoutLines.length).toBeGreaterThan(0)
    const checkoutRefLine = jobBlock.find((l) => /^\s+ref:/.test(l)) ?? ""
    expect(checkoutRefLine).toContain(CANDIDATE_EXPR)
    expect(checkoutRefLine).not.toContain("${{ github.sha }}")
  })

  it("benchmark job verifies the checked-out git HEAD", () => {
    const content = readFileSync(CI_WORKFLOW, "utf-8")
    const jobBlock = extractBlockLines(content, "  benchmark-runtime:")
    const joined = jobBlock.join("\n")
    expect(joined).toContain("git rev-parse HEAD")
    expect(joined).toContain("$CANDIDATE_SHA")
    expect(joined).toContain("does not match the PR branch head")
  })

  it("benchmark run uses the resolved candidate SHA, never standalone github.sha", () => {
    const content = readFileSync(CI_WORKFLOW, "utf-8")
    const jobBlock = extractBlockLines(content, "  benchmark-runtime:")
    const joined = jobBlock.join("\n")
    expect(joined).toContain('--expect-candidate-sha "$CANDIDATE_SHA"')
    expect(joined).toContain(`--expect-baseline-sha "${BASELINE_SHA}"`)
    // No standalone github.sha usage inside the benchmark job.
    expect(joined).not.toMatch(/\$\{\{ github\.sha \}\}/)
  })

  it("artifact name is bound to the resolved candidate SHA", () => {
    const content = readFileSync(CI_WORKFLOW, "utf-8")
    const jobBlock = extractBlockLines(content, "  benchmark-runtime:")
    const nameLine = jobBlock.find((l) => /^\s+name: benchmark-artifacts-/.test(l)) ?? ""
    expect(nameLine).toContain("benchmark-artifacts-" + CANDIDATE_EXPR)
    expect(nameLine).not.toContain("${{ github.sha }}")
  })

  it("artifact verification step validates candidateSha, comparison, sample profile", () => {
    const content = readFileSync(CI_WORKFLOW, "utf-8")
    const jobBlock = extractBlockLines(content, "  benchmark-runtime:")
    const joined = jobBlock.join("\n")
    expect(joined).toContain("baseline-vs-candidate")
    expect(joined).toContain("candidateSha !== expectedSha")
    expect(joined).toContain("comparison.passed !== true")
    expect(joined).toContain("comparison.regressions.length !== 0")
    expect(joined).toContain('sampleProfile !== "full"')
  })
})
