import { spawnSync } from "child_process"
import { readFileSync, existsSync, rmSync, mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { fileURLToPath } from "url"

/**
 * Validate user-supplied threshold environment variable.
 * Must be a finite number between 0 and 100.
 */
export function validateThreshold(thresholdRaw = process.env.COVERAGE_THRESHOLD) {
  if (thresholdRaw === undefined || thresholdRaw === null || thresholdRaw === "") {
    return 80.0
  }

  const parsed = Number(thresholdRaw)
  if (!Number.isFinite(parsed) || isNaN(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`Invalid COVERAGE_THRESHOLD: "${thresholdRaw}". Threshold must be a finite number between 0 and 100.`)
  }

  return parsed
}

/**
 * Check whether a file path qualifies as a repository source file.
 * Includes only files under src/, excluding tests, fixtures, declarations, dist, node_modules.
 */
export function isEligibleSourceFile(filePath) {
  if (!filePath || typeof filePath !== "string") return false

  const normalized = filePath.replace(/\\/g, "/")

  // Must be under src/ or /src/
  const isSrc = normalized.startsWith("src/") || normalized.includes("/src/")
  if (!isSrc) return false

  // Exclude node_modules, dist, declarations, fixtures, tests, scratch
  if (normalized.includes("node_modules/")) return false
  if (normalized.includes("/dist/") || normalized.startsWith("dist/")) return false
  if (normalized.endsWith(".d.ts")) return false
  if (normalized.includes("/tests/") || normalized.includes("/fixtures/") || normalized.includes("/__tests__/")) return false
  if (normalized.endsWith(".test.ts") || normalized.endsWith(".test.js") || normalized.endsWith(".spec.ts") || normalized.endsWith(".spec.js")) return false

  return true
}

/**
 * Parse standard lcov.info content and calculate weighted aggregate line coverage.
 */
export function parseLcov(lcovContent) {
  if (!lcovContent || typeof lcovContent !== "string" || lcovContent.trim().length === 0) {
    throw new Error("Coverage report is empty or missing")
  }

  const records = lcovContent.split("end_of_record")
  let totalCovered = 0
  let totalExecutable = 0
  let fileCount = 0

  for (const record of records) {
    const lines = record.split("\n")
    let currentFile = null
    let lh = null
    let lf = null

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith("SF:")) {
        currentFile = trimmed.slice(3).trim()
      } else if (trimmed.startsWith("LH:")) {
        lh = parseInt(trimmed.slice(3).trim(), 10)
      } else if (trimmed.startsWith("LF:")) {
        lf = parseInt(trimmed.slice(3).trim(), 10)
      }
    }

    if (currentFile && isEligibleSourceFile(currentFile) && lh !== null && lf !== null) {
      if (isNaN(lh) || isNaN(lf)) {
        throw new Error(`Malformed coverage record for file: ${currentFile}`)
      }
      totalCovered += lh
      totalExecutable += lf
      fileCount++
    }
  }

  if (fileCount === 0 || totalExecutable === 0) {
    throw new Error("No eligible src/ source files with executable lines found in coverage report")
  }

  const percentage = Math.round((totalCovered / totalExecutable) * 10000) / 100

  return {
    coveredLines: totalCovered,
    totalLines: totalExecutable,
    percentage,
    fileCount,
  }
}

/**
 * Main coverage execution wrapper.
 */
export function runCoverageCheck(thresholdRaw = process.env.COVERAGE_THRESHOLD) {
  const threshold = validateThreshold(thresholdRaw)
  const tempDir = mkdtempSync(join(tmpdir(), "fd-cov-"))
  const bunCmd = process.platform === "win32" ? "bun.cmd" : "bun"

  try {
    let proc = spawnSync(bunCmd, ["test", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${tempDir}`], {
      shell: false,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    })

    if (proc.error || proc.status === null) {
      proc = spawnSync(`bun test --coverage --coverage-reporter=lcov --coverage-dir="${tempDir}"`, {
        shell: true,
        encoding: "utf-8",
        maxBuffer: 50 * 1024 * 1024,
      })
    }

    if (proc.status !== 0) {
      const errOutput = (proc.stdout || "") + "\n" + (proc.stderr || "")
      throw new Error(`Coverage test execution failed with exit code ${proc.status}:\n${errOutput.slice(0, 500)}`)
    }

    const lcovFile = join(tempDir, "lcov.info")
    if (!existsSync(lcovFile)) {
      throw new Error(`Coverage report file lcov.info was not created at ${lcovFile}`)
    }

    const lcovContent = readFileSync(lcovFile, "utf-8")
    const { coveredLines, totalLines, percentage, fileCount } = parseLcov(lcovContent)

    console.log(`Measured weighted aggregate line coverage: ${percentage}% (${coveredLines}/${totalLines} lines across ${fileCount} source files). Required threshold: ${threshold}%`)

    if (percentage < threshold) {
      throw new Error(`Coverage threshold not met: ${percentage}% is below required threshold of ${threshold}%`)
    }

    console.log(`\n[SUCCESS] Coverage threshold requirement satisfied (${percentage}% >= ${threshold}%).`)
    return { status: 0, percentage, coveredLines, totalLines, fileCount }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup of temporary directory
    }
  }
}

// Execute CLI entry point when run directly
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  try {
    runCoverageCheck()
    process.exit(0)
  } catch (err) {
    console.error(`\n[ERROR] ${err.message}`)
    process.exit(1)
  }
}
