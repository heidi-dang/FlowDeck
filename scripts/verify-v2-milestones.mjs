import fs from "node:fs"
const file = new URL("../docs/v2/milestone-completion.json", import.meta.url)
const expected = ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8"]
const allowed = new Set(["CLOSED", "PARTIAL", "OPEN", "SUPERSEDED"])
export function validateV2Milestones(report) {
  if (!Array.isArray(report?.milestones) || report.milestones.length !== expected.length) throw new Error("V2 milestone denominator must contain exactly M1-M8")
  const ids = report.milestones.map(m => m.id)
  if (new Set(ids).size !== expected.length || expected.some(id => !ids.includes(id))) throw new Error("V2 milestone ids must be exactly M1-M8")
  for (const milestone of report.milestones) {
    if (!allowed.has(milestone.status)) throw new Error(`Invalid milestone status: ${milestone.id}`)
    if (milestone.status === "SUPERSEDED" && !milestone.justification) throw new Error(`${milestone.id} superseded without justification`)
    if (milestone.status === "CLOSED") {
      const evidence = milestone.evidence
      if (!evidence || evidence.production !== true || evidence.persistence !== true || evidence.recovery !== true || evidence.tests !== true) throw new Error(`${milestone.id} CLOSED without production/persistence/recovery/tests evidence`)
    }
  }
  const closed = report.milestones.filter(m => m.status === "CLOSED").length
  const partial = report.milestones.filter(m => m.status === "PARTIAL").length
  const open = report.milestones.filter(m => m.status === "OPEN").length
  const superseded = report.milestones.filter(m => m.status === "SUPERSEDED").length
  const completion = closed / expected.length * 100
  if (completion === 100 && (partial || open)) throw new Error("100% is impossible with partial/open milestones")
  const summary = { completion, closed, superseded, partial, open }
  if (report.completion !== undefined && report.completion !== completion) throw new Error("V2 milestone completion rollup is inconsistent")
  for (const key of ["closed", "superseded", "partial", "open"]) {
    if (report[key] !== undefined && report[key] !== summary[key]) throw new Error(`V2 milestone ${key} rollup is inconsistent`)
    if (report.counts?.[key] !== undefined && report.counts[key] !== summary[key]) throw new Error(`V2 milestone counts.${key} rollup is inconsistent`)
  }
  return summary
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(validateV2Milestones(JSON.parse(fs.readFileSync(file, "utf8")))))
