import fs from "node:fs"

const IDS = Array.from({ length: 14 }, (_, index) => `B${index + 1}`)
const SHA = /^[0-9a-f]{40}$/

export function validateBenchmarkReport(report) {
  if (!report || report.version < 3) throw new Error("V2 benchmark report version is unsupported")
  if (!SHA.test(report.baselineSha) || !SHA.test(report.candidateSha)) throw new Error("V2 benchmark SHAs must be full commit ids")
  if (!Array.isArray(report.results) || report.results.length !== IDS.length) throw new Error("V2 benchmark must contain B1-B14 candidate results")
  if (!report.results.every(result => IDS.includes(result.benchmarkId) && result.mode === "parallel" && typeof result.success === "boolean")) throw new Error("V2 candidate benchmark results are incomplete")
  if (!report.baselineComparison || report.baselineComparison.status !== "serial-reference") throw new Error("V2 benchmark must include a serial reference")
  if (report.baselineComparison.historicalBaselineStatus !== "not-executed") throw new Error("Historical baseline status must be explicit")
  const reference = report.baselineComparison.results
  if (!Array.isArray(reference) || reference.length !== IDS.length || !reference.every(result => IDS.includes(result.benchmarkId) && result.mode === "serial-reference" && typeof result.success === "boolean")) throw new Error("V2 serial reference results are incomplete")
  if (new Set(report.results.map(result => result.benchmarkId)).size !== IDS.length) throw new Error("V2 candidate benchmark ids must be unique")
  if (new Set(reference.map(result => result.benchmarkId)).size !== IDS.length) throw new Error("V2 serial benchmark ids must be unique")
  return { benchmarks: IDS.length, candidateSuccess: report.results.every(result => result.success), referenceSuccess: reference.every(result => result.success) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] ?? "/tmp/flowdeck-v2-benchmark.json"
  const report = JSON.parse(fs.readFileSync(file, "utf8"))
  console.log(JSON.stringify(validateBenchmarkReport(report)))
}
