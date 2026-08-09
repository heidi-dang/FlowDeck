import { describe, expect, it } from "bun:test"
import { validateBenchmarkReport } from "../scripts/verify-v2-benchmark.mjs"

const sha = "0123456789abcdef0123456789abcdef01234567"
const results = (mode: "parallel" | "serial-reference") => Array.from({ length: 14 }, (_, index) => ({ benchmarkId: `B${index + 1}`, mode, success: true }))

describe("v2 benchmark report validator", () => {
  it("requires all reproducible candidate and serial-reference cases", () => {
    expect(validateBenchmarkReport({ version: 3, baselineSha: sha, candidateSha: sha, results: results("parallel"), baselineComparison: { status: "serial-reference", historicalBaselineStatus: "not-executed", results: results("serial-reference") } })).toEqual({ benchmarks: 14, candidateSuccess: true, referenceSuccess: true })
  })

  it("rejects incomplete or hand-waved benchmark output", () => {
    expect(() => validateBenchmarkReport({ version: 3, baselineSha: sha, candidateSha: sha, results: results("parallel").slice(0, 13), baselineComparison: { status: "not-executed", results: [] } })).toThrow()
  })
})
