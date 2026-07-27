import { describe, it, expect } from "vitest"
import { validateThreshold, isEligibleSourceFile, parseLcov } from "../scripts/check-coverage.mjs"

describe("Coverage Checker Unit Tests (tests/check-coverage.test.ts)", () => {
  describe("Threshold Validation", () => {
    it("default threshold is 80", () => {
      expect(validateThreshold(undefined)).toBe(80)
      expect(validateThreshold("")).toBe(80)
    })

    it("accepts valid numeric thresholds", () => {
      expect(validateThreshold("85")).toBe(85)
      expect(validateThreshold("0")).toBe(0)
      expect(validateThreshold("100")).toBe(100)
      expect(validateThreshold("79.99")).toBe(79.99)
    })

    it("rejects invalid threshold 'abc'", () => {
      expect(() => validateThreshold("abc")).toThrow(/Invalid COVERAGE_THRESHOLD/)
    })

    it("rejects NaN threshold", () => {
      expect(() => validateThreshold(NaN as any)).toThrow(/Invalid COVERAGE_THRESHOLD/)
      expect(() => validateThreshold("NaN")).toThrow(/Invalid COVERAGE_THRESHOLD/)
    })

    it("rejects Infinity threshold", () => {
      expect(() => validateThreshold(Infinity as any)).toThrow(/Invalid COVERAGE_THRESHOLD/)
      expect(() => validateThreshold("Infinity")).toThrow(/Invalid COVERAGE_THRESHOLD/)
    })

    it("rejects threshold below 0", () => {
      expect(() => validateThreshold("-1")).toThrow(/Invalid COVERAGE_THRESHOLD/)
      expect(() => validateThreshold(-5 as any)).toThrow(/Invalid COVERAGE_THRESHOLD/)
    })

    it("rejects threshold above 100", () => {
      expect(() => validateThreshold("101")).toThrow(/Invalid COVERAGE_THRESHOLD/)
      expect(() => validateThreshold(150 as any)).toThrow(/Invalid COVERAGE_THRESHOLD/)
    })
  })

  describe("Eligible Source File Filtering", () => {
    it("includes src/ files", () => {
      expect(isEligibleSourceFile("src/tools/fdx.ts")).toBe(true)
      expect(isEligibleSourceFile("src\\services\\audit-log.ts")).toBe(true)
    })

    it("excludes test files, declarations, dist, node_modules, and fixtures", () => {
      expect(isEligibleSourceFile("src/tools/fdx.test.ts")).toBe(false)
      expect(isEligibleSourceFile("src/types/index.d.ts")).toBe(false)
      expect(isEligibleSourceFile("dist/index.js")).toBe(false)
      expect(isEligibleSourceFile("node_modules/bun/index.js")).toBe(false)
      expect(isEligibleSourceFile("tests/index.test.ts")).toBe(false)
      expect(isEligibleSourceFile("src/fixtures/mock.ts")).toBe(false)
    })
  })

  describe("Weighted Aggregate Calculation & Report Parsing", () => {
    it("calculates weighted aggregate calculation correctly", () => {
      const mockLcov = `
TN:
SF:src/file1.ts
DA:1,1
LH:80
LF:100
end_of_record
TN:
SF:src/file2.ts
DA:1,1
LH:40
LF:100
end_of_record
`
      const res = parseLcov(mockLcov)
      expect(res.coveredLines).toBe(120)
      expect(res.totalLines).toBe(200)
      expect(res.percentage).toBe(60)
    })

    it("proves a large low-coverage file outweighs a tiny high-coverage file", () => {
      // Tiny file: 10/10 = 100%
      // Large file: 100/1000 = 10%
      // Simple average of percentages: (100% + 10%) / 2 = 55%
      // Weighted aggregate: (10 + 100) / (10 + 1000) = 110 / 1010 = 10.89%
      const mockLcov = `
TN:
SF:src/tiny.ts
LH:10
LF:10
end_of_record
TN:
SF:src/large.ts
LH:100
LF:1000
end_of_record
`
      const res = parseLcov(mockLcov)
      expect(res.percentage).toBe(10.89)
      expect(res.percentage).not.toBe(55)
    })

    it("exactly 80% passes threshold check", () => {
      const mockLcov = `
TN:
SF:src/a.ts
LH:80
LF:100
end_of_record
`
      const res = parseLcov(mockLcov)
      expect(res.percentage).toBe(80)
      expect(res.percentage >= 80).toBe(true)
    })

    it("79.99% fails threshold check", () => {
      const mockLcov = `
TN:
SF:src/a.ts
LH:7999
LF:10000
end_of_record
`
      const res = parseLcov(mockLcov)
      expect(res.percentage).toBe(79.99)
      expect(res.percentage >= 80).toBe(false)
    })

    it("fails on missing report", () => {
      expect(() => parseLcov("")).toThrow(/empty or missing/)
      expect(() => parseLcov(null as any)).toThrow(/empty or missing/)
    })

    it("fails on malformed report record", () => {
      const malformedLcov = `
TN:
SF:src/a.ts
LH:abc
LF:100
end_of_record
`
      expect(() => parseLcov(malformedLcov)).toThrow(/Malformed coverage record/)
    })

    it("fails when no eligible src files are present in report", () => {
      const distOnlyLcov = `
TN:
SF:dist/index.js
LH:100
LF:100
end_of_record
`
      expect(() => parseLcov(distOnlyLcov)).toThrow(/No eligible src\/ source files/)
    })

    it("fails when no executable source lines are present", () => {
      const zeroLinesLcov = `
TN:
SF:src/empty.ts
LH:0
LF:0
end_of_record
`
      expect(() => parseLcov(zeroLinesLcov)).toThrow(/No eligible src\/ source files with executable lines/)
    })
  })
})
