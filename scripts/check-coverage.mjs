import { spawnSync } from "child_process"
import { readFileSync, existsSync, rmSync, mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { fileURLToPath } from "url"

/**
 * Locate the native bun executable for spawnSync without shell execution.
 */
export function getBunExecutable() {
  if (process.platform !== "win32") return "bun"

  if (process.env.BUN_BIN && existsSync(process.env.BUN_BIN)) {
    return process.env.BUN_BIN
  }

  const appData = process.env.APPDATA
  if (appData) {
    const npmBunExe = join(appData, "npm", "node_modules", "bun", "bin", "bun.exe")
    if (existsSync(npmBunExe)) return npmBunExe
  }

  const userProfile = process.env.USERPROFILE
  if (userProfile) {
    const userBunExe = join(userProfile, ".bun", "bin", "bun.exe")
    if (existsSync(userBunExe)) return userBunExe
  }

  return "bun.exe"
}

/**
 * Validate user-supplied threshold environment variable.
 * Must be a finite number between 0 and 100.
 *
 * Rules:
 *   - Environment variable absent (undefined) -> default to 80.0
 *   - Environment variable empty string ("") -> throw Error
 *   - Environment variable whitespace-only ("   ") -> throw Error
 *   - Invalid numeric strings, NaN, Infinity, <0, >100 -> throw Error
 */
export function validateThreshold(thresholdRaw = process.env.COVERAGE_THRESHOLD) {
  if (arguments.length > 0 && arguments[0] === undefined) {
    return 80.0
  }
  if (thresholdRaw === undefined) {
    return 80.0
  }

  if (typeof thresholdRaw !== "string" && typeof thresholdRaw !== "number") {
    throw new Error(`Invalid COVERAGE_THRESHOLD: threshold must be a string or number, received ${typeof thresholdRaw}`)
  }

  const strVal = String(thresholdRaw)
  if (strVal.trim().length === 0) {
    throw new Error(`Invalid COVERAGE_THRESHOLD: "${thresholdRaw}". Explicit empty or whitespace-only threshold is not allowed.`)
  }

  const parsed = Number(strVal)
  if (!Number.isFinite(parsed) || isNaN(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(`Invalid COVERAGE_THRESHOLD: "${thresholdRaw}". Threshold must be a finite number between 0 and 100.`)
  }

  return parsed
}

/**
 * Check whether a file path qualifies as a repository source file under src/.
 * Excludes tests, fixtures, declarations, dist, node_modules.
 */
export function isEligibleSourceFile(filePath) {
  if (!filePath || typeof filePath !== "string") return false

  const normalized = filePath.replace(/\\/g, "/")

  const isSrc = normalized.startsWith("src/") || normalized.includes("/src/")
  if (!isSrc) return false

  if (normalized.includes("node_modules/")) return false
  if (normalized.includes("/dist/") || normalized.startsWith("dist/")) return false
  if (normalized.endsWith(".d.ts")) return false
  if (normalized.includes("/tests/") || normalized.includes("/fixtures/") || normalized.includes("/__tests__/")) return false
  if (normalized.endsWith(".test.ts") || normalized.endsWith(".test.js") || normalized.endsWith(".spec.ts") || normalized.endsWith(".spec.js")) return false

  return true
}

/**
 * Parse standard lcov.info content and calculate raw and display line coverage.
 * Fails closed on incomplete, malformed, or invalid eligible src records.
 */
export function parseLcov(lcovContent) {
  if (lcovContent === undefined || lcovContent === null || typeof lcovContent !== "string" || lcovContent.trim().length === 0) {
    throw new Error("Coverage report is empty or missing")
  }

  const records = lcovContent.split("end_of_record")
  let totalCovered = 0
  let totalExecutable = 0
  let fileCount = 0

  for (const record of records) {
    const lines = record.split("\n")
    let currentFile = null
    const lhValues = []
    const lfValues = []

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith("SF:")) {
        currentFile = trimmed.slice(3).trim()
      } else if (trimmed.startsWith("LH:")) {
        lhValues.push(trimmed.slice(3).trim())
      } else if (trimmed.startsWith("LF:")) {
        lfValues.push(trimmed.slice(3).trim())
      }
    }

    if (currentFile && isEligibleSourceFile(currentFile)) {
      if (lhValues.length === 0 || lfValues.length === 0) {
        throw new Error(`Incomplete coverage record for eligible file "${currentFile}": missing LH or LF field`)
      }
      if (lhValues.length > 1 || lfValues.length > 1) {
        throw new Error(`Malformed coverage record for eligible file "${currentFile}": duplicate LH or LF fields`)
      }

      const lhStr = lhValues[0]
      const lfStr = lfValues[0]
      const lh = Number(lhStr)
      const lf = Number(lfStr)

      if (!Number.isInteger(lh) || !Number.isInteger(lf) || isNaN(lh) || isNaN(lf)) {
        throw new Error(`Invalid numeric coverage values for file "${currentFile}": LH="${lhStr}", LF="${lfStr}"`)
      }

      if (lh < 0 || lf < 0) {
        throw new Error(`Negative coverage values for file "${currentFile}": LH=${lh}, LF=${lf}`)
      }

      if (lh > lf) {
        throw new Error(`Invalid coverage ratio for file "${currentFile}": LH (${lh}) is greater than LF (${lf})`)
      }

      totalCovered += lh
      totalExecutable += lf
      fileCount++
    }
  }

  if (fileCount === 0 || totalExecutable === 0) {
    throw new Error("No eligible src/ source files with executable lines found in coverage report")
  }

  const rawPercentage = (totalCovered / totalExecutable) * 100
  const displayPercentage = Math.round(rawPercentage * 100) / 100

  return {
    coveredLines: totalCovered,
    totalLines: totalExecutable,
    rawPercentage,
    displayPercentage,
    fileCount,
  }
}

export function evaluateProcessResult(proc, tempDir, threshold) {
  if (proc.error) {
    throw new Error(`Coverage test process execution error: ${proc.error.message}`)
  }

  if (proc.signal) {
    throw new Error(`Coverage test process terminated by signal: ${proc.signal}`)
  }

  if (proc.status === null) {
    throw new Error(`Coverage test process exited with null status`)
  }

  if (proc.status !== 0) {
    const fullOut = (proc.stdout || "") + "\n" + (proc.stderr || "")
    const failLines = fullOut.split("\n").filter(l => /fail|error|exception|stack|at /i.test(l)).slice(-30).join("\n")
    const tailOut = fullOut.slice(-3000)
    throw new Error(`Coverage test execution failed with exit code ${proc.status}:\n--- FAILING LINES ---\n${failLines}\n--- TAIL OUTPUT ---\n${tailOut}`)
  }

  const lcovFile = join(tempDir, "lcov.info")
  if (!existsSync(lcovFile)) {
    throw new Error(`Coverage report file lcov.info was not created at ${lcovFile}`)
  }

  const lcovContent = readFileSync(lcovFile, "utf-8")
  const { coveredLines, totalLines, rawPercentage, displayPercentage, fileCount } = parseLcov(lcovContent)

  console.log(`Measured weighted aggregate line coverage: ${displayPercentage}% (raw: ${rawPercentage}%, ${coveredLines}/${totalLines} lines across ${fileCount} source files). Required threshold: ${threshold}%`)

  // Raw percentage controls pass/fail; display percentage is display-only
  if (rawPercentage < threshold) {
    throw new Error(`Coverage threshold not met: ${displayPercentage}% is below required threshold of ${threshold}%`)
  }

  console.log(`\n[SUCCESS] Coverage threshold requirement satisfied (${displayPercentage}% >= ${threshold}%).`)
  return { status: 0, rawPercentage, displayPercentage, coveredLines, totalLines, fileCount }
}

/**
 * Main coverage execution wrapper without shell fallback.
 */
export function runCoverageCheckWithRunner(thresholdRaw = process.env.COVERAGE_THRESHOLD, runner = spawnSync) {
  const threshold = validateThreshold(thresholdRaw)
  const tempDir = mkdtempSync(join(tmpdir(), "fd-cov-"))
  const bunBin = getBunExecutable()

  try {
    const proc = runner(bunBin, ["test", "--coverage", "--coverage-reporter=lcov", `--coverage-dir=${tempDir}`], {
      shell: false,
      encoding: "utf-8",
      maxBuffer: 50 * 1024 * 1024,
    })

    return evaluateProcessResult(proc, tempDir, threshold)
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup of temporary directory
    }
  }
}

export function runCoverageCheck(thresholdRaw = process.env.COVERAGE_THRESHOLD) {
  return runCoverageCheckWithRunner(thresholdRaw)
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
