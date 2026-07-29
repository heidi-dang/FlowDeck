import { describe, it, expect } from "bun:test"
import { validateThreshold, isEligibleSourceFile, parseLcov, getBunExecutable, evaluateProcessResult, runCoverageCheckWithRunner } from "../scripts/check-coverage.mjs"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

describe("Coverage Checker Unit Tests (tests/check-coverage.test.ts)", () => {
  describe("Threshold Validation", () => {
    it("absent threshold (undefined) defaults to 80", () => {
      expect(validateThreshold(undefined)).toBe(80)
    })

    it("rejects explicitly empty threshold string", () => {
      expect(() => validateThreshold("")).toThrow(/Explicit empty or whitespace-only threshold is not allowed/)
    })

    it("rejects whitespace-only threshold string", () => {
      expect(() => validateThreshold("   ")).toThrow(/Explicit empty or whitespace-only threshold is not allowed/)
      expect(() => validateThreshold("\t\n")).toThrow(/Explicit empty or whitespace-only threshold is not allowed/)
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

  describe("Weighted Aggregate Calculation & Raw Percentage Boundary Rules", () => {
    it("calculates weighted aggregate calculation correctly", () => {
      const mockLcov = `
TN:
SF:src/file1.ts
LH:80
LF:100
end_of_record
TN:
SF:src/file2.ts
LH:40
LF:100
end_of_record
`
      const res = parseLcov(mockLcov)
      expect(res.coveredLines).toBe(120)
      expect(res.totalLines).toBe(200)
      expect(res.rawPercentage).toBe(60)
      expect(res.displayPercentage).toBe(60)
    })

    it("proves a large low-coverage file outweighs a tiny high-coverage file", () => {
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
      expect(res.rawPercentage).toBeCloseTo(10.891, 3)
      expect(res.rawPercentage).not.toBe(55)
    })

    it("79.994% fails at an 80% threshold", () => {
      const mockLcov = `
TN:
SF:src/a.ts
LH:79994
LF:100000
end_of_record
`
      const res = parseLcov(mockLcov)
      expect(res.rawPercentage).toBe(79.994)
      expect(res.rawPercentage < 80).toBe(true)
    })

    it("79.995% fails at an 80% threshold (raw value fails despite rounding to 80.00%)", () => {
      const mockLcov = `
TN:
SF:src/a.ts
LH:79995
LF:100000
end_of_record
`
      const res = parseLcov(mockLcov)
      expect(res.rawPercentage).toBe(79.995)
      expect(res.displayPercentage).toBe(80.0)
      expect(res.rawPercentage < 80).toBe(true)
    })

    it("79.999% fails at an 80% threshold", () => {
      const mockLcov = `
TN:
SF:src/a.ts
LH:79999
LF:100000
end_of_record
`
      const res = parseLcov(mockLcov)
      expect(res.rawPercentage).toBe(79.999)
      expect(res.rawPercentage < 80).toBe(true)
    })

    it("80.000% passes at an 80% threshold", () => {
      const mockLcov = `
TN:
SF:src/a.ts
LH:80000
LF:100000
end_of_record
`
      const res = parseLcov(mockLcov)
      expect(res.rawPercentage).toBe(80.0)
      expect(res.rawPercentage >= 80).toBe(true)
    })
  })

  describe("Fail-Closed Parser Verification on Incomplete / Malformed LCOV Records", () => {
    it("fails when report is empty or missing", () => {
      expect(() => parseLcov("")).toThrow(/empty or missing/)
      expect(() => parseLcov(null as any)).toThrow(/empty or missing/)
    })

    it("fails when eligible src record is missing LH field", () => {
      const missingLh = `
TN:
SF:src/a.ts
LF:100
end_of_record
`
      expect(() => parseLcov(missingLh)).toThrow(/Incomplete coverage record.*missing LH or LF/)
    })

    it("fails when eligible src record is missing LF field", () => {
      const missingLf = `
TN:
SF:src/a.ts
LH:80
end_of_record
`
      expect(() => parseLcov(missingLf)).toThrow(/Incomplete coverage record.*missing LH or LF/)
    })

    it("fails when eligible src record has non-numeric LH:abc", () => {
      const invalidLh = `
TN:
SF:src/a.ts
LH:abc
LF:100
end_of_record
`
      expect(() => parseLcov(invalidLh)).toThrow(/Invalid numeric coverage values/)
    })

    it("fails when eligible src record has non-numeric LF:abc", () => {
      const invalidLf = `
TN:
SF:src/a.ts
LH:80
LF:abc
end_of_record
`
      expect(() => parseLcov(invalidLf)).toThrow(/Invalid numeric coverage values/)
    })

    it("fails when eligible src record has LH greater than LF", () => {
      const lhGreaterThanLf = `
TN:
SF:src/a.ts
LH:120
LF:100
end_of_record
`
      expect(() => parseLcov(lhGreaterThanLf)).toThrow(/Invalid coverage ratio.*LH \(120\) is greater than LF \(100\)/)
    })

    it("fails when eligible src record has negative values", () => {
      const negativeLh = `
TN:
SF:src/a.ts
LH:-5
LF:100
end_of_record
`
      expect(() => parseLcov(negativeLh)).toThrow(/Negative coverage values/)
    })

    it("ignores non-src records missing LH or LF without error", () => {
      const nonSrcMissing = `
TN:
SF:dist/index.js
LF:100
end_of_record
TN:
SF:src/valid.ts
LH:80
LF:100
end_of_record
`
      const res = parseLcov(nonSrcMissing)
      expect(res.coveredLines).toBe(80)
      expect(res.totalLines).toBe(100)
    })
  })

  describe("Strict Child-Process Failure Rejection Tests", () => {
    it("exit 0 + valid LCOV -> pass", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cov-test-pass-"))
      try {
        const lcovContent = "TN:\nSF:src/a.ts\nLH:90\nLF:100\nend_of_record\n"
        writeFileSync(join(tempDir, "lcov.info"), lcovContent)
        const proc = { status: 0, stdout: "100 pass\n", stderr: "", error: null, signal: null }
        const res = evaluateProcessResult(proc, tempDir, 80)
        expect(res.rawPercentage).toBe(90)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it("exit 1 + valid LCOV -> fail", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cov-test-fail1-"))
      try {
        writeFileSync(join(tempDir, "lcov.info"), "TN:\nSF:src/a.ts\nLH:90\nLF:100\nend_of_record\n")
        const proc = { status: 1, stdout: "1 fail\n", stderr: "", error: null, signal: null }
        expect(() => evaluateProcessResult(proc, tempDir, 80)).toThrow(/failed with exit code 1/)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it("exit 2 + valid LCOV -> fail", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cov-test-fail2-"))
      try {
        writeFileSync(join(tempDir, "lcov.info"), "TN:\nSF:src/a.ts\nLH:90\nLF:100\nend_of_record\n")
        const proc = { status: 2, stdout: "1 fail\n", stderr: "", error: null, signal: null }
        expect(() => evaluateProcessResult(proc, tempDir, 80)).toThrow(/failed with exit code 2/)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it("exit 2 + no 'fail' text -> fail", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cov-test-fail2nofail-"))
      try {
        writeFileSync(join(tempDir, "lcov.info"), "TN:\nSF:src/a.ts\nLH:90\nLF:100\nend_of_record\n")
        const proc = { status: 2, stdout: "all tests passed\n", stderr: "", error: null, signal: null }
        expect(() => evaluateProcessResult(proc, tempDir, 80)).toThrow(/failed with exit code 2/)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it("exit null -> fail", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cov-test-null-"))
      try {
        writeFileSync(join(tempDir, "lcov.info"), "TN:\nSF:src/a.ts\nLH:90\nLF:100\nend_of_record\n")
        const proc = { status: null, stdout: "", stderr: "", error: null, signal: null }
        expect(() => evaluateProcessResult(proc, tempDir, 80)).toThrow(/exited with null status/)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it("spawn error -> fail", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cov-test-err-"))
      try {
        const proc = { status: null, stdout: "", stderr: "", error: new Error("ENOENT: spawn failed"), signal: null }
        expect(() => evaluateProcessResult(proc, tempDir, 80)).toThrow(/Coverage test process execution error: ENOENT/)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it("signal termination -> fail", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cov-test-sig-"))
      try {
        const proc = { status: null, stdout: "", stderr: "", error: null, signal: "SIGKILL" }
        expect(() => evaluateProcessResult(proc, tempDir, 80)).toThrow(/terminated by signal: SIGKILL/)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it("exit 0 + missing LCOV -> fail", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cov-test-nolcov-"))
      try {
        const proc = { status: 0, stdout: "ok\n", stderr: "", error: null, signal: null }
        expect(() => evaluateProcessResult(proc, tempDir, 80)).toThrow(/was not created/)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it("exit 0 + malformed LCOV -> fail", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "cov-test-badlcov-"))
      try {
        writeFileSync(join(tempDir, "lcov.info"), "INVALID_LCOV_DATA")
        const proc = { status: 0, stdout: "ok\n", stderr: "", error: null, signal: null }
        expect(() => evaluateProcessResult(proc, tempDir, 80)).toThrow(/No eligible src\/|empty or missing/)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    it("runCoverageCheckWithRunner integrates custom runner", () => {
      const mockRunner = (_bin: string, _args: string[], _opts: any) => {
        return { status: 1, stdout: "Error", stderr: "", error: null, signal: null }
      }
      expect(() => runCoverageCheckWithRunner(80, mockRunner)).toThrow(/failed with exit code 1/)
    })
  })

  describe("Executable Lookup without Shell", () => {
    it("getBunExecutable returns non-empty executable string", () => {
      const exe = getBunExecutable()
      expect(typeof exe).toBe("string")
      expect(exe.length).toBeGreaterThan(0)
    })
  })
})


