/**
 * Doctor Engine — reusable health audit for FlowDeck installations.
 *
 * Deterministic checks (no AI required). Shared by CLI, installer, and Web UI.
 * Categories: runtime, repository, environment, mcp, plugin, lsp, hook,
 * security, performance, configuration.
 */

import type { CheckResult, DoctorReport, DoctorOptions, Recommendation, AutoFixResult } from "./types"
import { runRuntimeChecks } from "./checks/runtime"
import { runRepositoryChecks } from "./checks/repository"
import { runEnvironmentChecks } from "./checks/environment"
import { runMCPChecks } from "./checks/mcp"
import { runPluginChecks } from "./checks/plugin"
import { runHookChecks } from "./checks/hooks"
import { runSecurityChecks } from "./checks/security"
import { runConfigurationChecks } from "./checks/configuration"
import { generateRecommendations } from "./recommendations/recommendations"
import { resolveProfile } from "./profiles/profiles"
import { applyAutoFixes } from "./apply/apply"
import { readFileSync } from "fs"
import { join } from "path"

let PKG_VERSION = "0.0.0"
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"))
  PKG_VERSION = pkg.version || PKG_VERSION
} catch { /* ignore */ }

export { CheckResult, DoctorReport, DoctorOptions, Recommendation, AutoFixResult }
export type { CheckStatus, Severity, CheckCategory } from "./types"

export async function runDoctor(directory: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const allChecks: CheckResult[] = []

  // Run all check categories in parallel
  const results = await Promise.all([
    runRuntimeChecks(directory),
    runRepositoryChecks(directory),
    runEnvironmentChecks(directory),
    runMCPChecks(directory),
    runPluginChecks(directory),
    runHookChecks(directory),
    runSecurityChecks(directory),
    runConfigurationChecks(directory),
  ])

  for (const checks of results) {
    allChecks.push(...checks)
  }

  // Filter by strict mode (only errors and high severity)
  if (options.strict) {
    allChecks.filter(c => c.severity === "critical" || c.severity === "high" || c.status === "error")
  }

  // Tally
  const passed = allChecks.filter(c => c.status === "pass").length
  const warnings = allChecks.filter(c => c.status === "warning").length
  const errors = allChecks.filter(c => c.status === "error").length
  const info = allChecks.filter(c => c.status === "info").length
  const skipped = allChecks.filter(c => c.status === "skipped").length
  const total = allChecks.length

  // Calculate scores (0-100)
  const envScore = scoreCategory(allChecks, "runtime", "environment")
  const secScore = scoreCategory(allChecks, "security")
  const perfScore = scoreCategory(allChecks, "performance")
  const configScore = scoreCategory(allChecks, "configuration", "mcp", "plugin", "hook", "lsp")
  const overall = Math.round((envScore + secScore + perfScore + configScore) / 4)

  // Generate recommendations
  const recommendations = generateRecommendations(allChecks)

  // Resolve profile
  const profile = resolveProfile(options.profile || "recommended-dev")

  // Apply auto-fixes if requested
  if (options.applyRecommended) {
    await applyAutoFixes(allChecks, options)
  }

  return {
    timestamp: new Date().toISOString(),
    version: PKG_VERSION,
    checks: allChecks,
    scores: {
      environment: envScore,
      security: secScore,
      performance: perfScore,
      configuration: configScore,
      overall,
    },
    recommendations,
    summary: { passed, warnings, errors, info, skipped, total },
    profile: profile.name,
  }
}

function scoreCategory(checks: CheckResult[], ...categories: string[]): number {
  const relevant = checks.filter(c => categories.includes(c.category))
  if (relevant.length === 0) return 100
  const passRatio = relevant.filter(c => c.status === "pass" || c.status === "info").length / relevant.length
  const errorPenalty = relevant.filter(c => c.status === "error").length * 15
  const warnPenalty = relevant.filter(c => c.status === "warning").length * 5
  const score = Math.max(0, Math.round(passRatio * 100 - errorPenalty - warnPenalty))
  return Math.min(100, score)
}

export function formatReport(report: DoctorReport, verbose: boolean = false): string {
  const lines: string[] = []

  // Header
  lines.push(`\n${"=".repeat(60)}`)
  lines.push(`  FlowDeck Doctor`)
  lines.push(`  Version: ${report.version}`)
  lines.push(`  Profile: ${report.profile}`)
  lines.push(`  Timestamp: ${report.timestamp}`)
  lines.push(`${"=".repeat(60)}\n`)

  // Summary / Diagnostics
  const total = report.summary.total
  const passed = report.summary.passed
  const warnings = report.summary.warnings
  const errors = report.summary.errors
  lines.push(`  Summary: ${total} checks | ${passed} Passed | ${warnings} warnings | ${errors} errors | ${report.summary.info} info | ${report.summary.skipped} skipped`)
  lines.push("")

  // Diagnostics
  lines.push(`  Diagnostics:`)

  // Scores
  lines.push(`  Scores:`)
  lines.push(`    Environment: ${report.scores.environment}/100`)
  lines.push(`    Security:    ${report.scores.security}/100`)
  lines.push(`    Performance: ${report.scores.performance}/100`)
  lines.push(`    Config:      ${report.scores.configuration}/100`)
  lines.push(`    ─────────────────────`)
  lines.push(`    Overall:     ${report.scores.overall}/100`)
  lines.push("")

  // Readiness
  const readiness = report.scores.overall >= 90 ? "Production Ready" :
    report.scores.overall >= 70 ? "Mostly Ready" :
    report.scores.overall >= 50 ? "Needs Work" : "Not Ready"
  lines.push(`  Readiness: ${readiness}`)
  lines.push("")

  // Errors (always shown)
  const errors_list = report.checks.filter(c => c.status === "error")
  if (errors_list.length > 0) {
    lines.push(`  [Errors]`)
    for (const c of errors_list) {
      lines.push(`    ✗ ${c.title}: ${c.detected}`)
      lines.push(`      Recommendation: ${c.recommendation}`)
      if (c.autoFixAvailable) lines.push(`      Auto-fix available: yes`)
      lines.push("")
    }
  }

  // Warnings
  if (verbose || errors_list.length === 0) {
    const warnings_list = report.checks.filter(c => c.status === "warning")
    if (warnings_list.length > 0) {
      lines.push(`  [Warnings]`)
      for (const c of warnings_list) {
        lines.push(`    ⚠ ${c.title}: ${c.detected}`)
        if (verbose) {
          lines.push(`      Expected: ${c.expected}`)
          lines.push(`      ${c.recommendation}`)
        }
        lines.push("")
      }
    }
  }

  // Recommendations
  if (report.recommendations.length > 0) {
    lines.push(`  [Recommendations]`)
    for (const r of report.recommendations) {
      const icon = r.type === "required" ? "❗" : r.type === "recommended" ? "★" : "○"
      lines.push(`    ${icon} [${r.type}] ${r.title}`)
      lines.push(`      ${r.description}`)
      if (r.autoFixAvailable) lines.push(`      Auto-fix: ${r.autoFixCommand || "available"}`)
      lines.push("")
    }
  }

  lines.push(`${"=".repeat(60)}\n`)
  return lines.join("\n")
}

export function formatJSON(report: DoctorReport): string {
  return JSON.stringify(report, null, 2)
}
