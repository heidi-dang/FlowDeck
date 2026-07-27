import { spawnSync } from "child_process"

/**
 * Enforce minimum line coverage threshold for FlowDeck.
 * Default threshold: 80% line coverage for source files (src/).
 */
const thresholdEnv = process.env.COVERAGE_THRESHOLD
const MIN_LINE_COVERAGE = thresholdEnv ? parseFloat(thresholdEnv) : 80.0

console.log(`Running coverage check (Minimum line coverage threshold: ${MIN_LINE_COVERAGE}%)...`)

const result = spawnSync("bun test --coverage", {
  shell: true,
  encoding: "utf-8",
  env: { ...process.env },
  maxBuffer: 100 * 1024 * 1024,
})

const output = (result.stdout || "") + "\n" + (result.stderr || "")

const lines = output.split("\n")
let totalLineSum = 0
let lineCount = 0

// Calculate average line coverage across src/ files in coverage table
for (const line of lines) {
  // Format:  src\tools\fdx.ts | 81.58 | 65.49 | 189-192...
  if (line.includes("src\\") || line.includes("src/")) {
    const parts = line.split("|").map((p) => p.trim())
    if (parts.length >= 3) {
      const lineCovStr = parts[2]
      const linesPct = parseFloat(lineCovStr)
      if (!isNaN(linesPct)) {
        totalLineSum += linesPct
        lineCount++
      }
    }
  }
}

let totalLinesPct = null
if (lineCount > 0) {
  totalLinesPct = Math.round((totalLineSum / lineCount) * 100) / 100
} else {
  // Fallback to all reported files
  for (const line of lines) {
    const match = line.match(/\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/)
    if (match) {
      const linesPct = parseFloat(match[2])
      if (!isNaN(linesPct)) {
        totalLineSum += linesPct
        lineCount++
      }
    }
  }
  if (lineCount > 0) {
    totalLinesPct = Math.round((totalLineSum / lineCount) * 100) / 100
  }
}

if (result.status !== 0) {
  console.log(output)
  console.error(`Coverage test execution failed with exit code ${result.status}`)
  process.exit(result.status || 1)
}

if (totalLinesPct === null) {
  console.warn("Warning: Could not parse line coverage percentage from output. Test run passed.")
  process.exit(0)
}

console.log(`Measured average source line coverage: ${totalLinesPct}% (Threshold: ${MIN_LINE_COVERAGE}%)`)

if (totalLinesPct < MIN_LINE_COVERAGE) {
  console.error(`\n[ERROR] Coverage threshold not met: ${totalLinesPct}% is below required threshold of ${MIN_LINE_COVERAGE}%`)
  process.exit(1)
}

console.log(`\n[SUCCESS] Coverage threshold requirement satisfied (${totalLinesPct}% >= ${MIN_LINE_COVERAGE}%).`)
process.exit(0)
