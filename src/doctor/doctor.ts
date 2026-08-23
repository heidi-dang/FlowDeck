/**
 * Doctor Engine — reusable health audit for FlowDeck installations.
 *
 * Deterministic checks (no AI required). Shared by CLI, installer, and Web UI.
 * Categories: runtime, repository, environment, mcp, plugin, lsp, hook,
 * security, performance, configuration, fdx, browser, skills, heidi, filesystem.
 */

import type { CheckResult, DoctorReport, DoctorOptions, } from "./types"
import { runRuntimeChecks } from "./checks/runtime"
import { runRepositoryChecks } from "./checks/repository"
import { runEnvironmentChecks } from "./checks/environment"
import { runMCPChecks } from "./checks/mcp"
import { runPluginChecks } from "./checks/plugin"
import { runHookChecks } from "./checks/hooks"
import { runSecurityChecks } from "./checks/security"
import { runConfigurationChecks } from "./checks/configuration"
import { runBrowserChecks } from "./checks/browser"
import { runCuratedSkillChecks } from "./checks/skills"
import { runStudioChecks } from "./checks/studio"
import { runFdxChecks } from "./checks/fdx"
import { runFilesystemChecks } from "./checks/filesystem"
import { runHeidiChecks } from "./checks/heidi"
import { generateRecommendations } from "./recommendations/recommendations"
import { resolveProfile } from "./profiles/profiles"
import { applyAutoFixes } from "./apply/apply"
import { readFileSync } from "fs"
import { join } from "path"

let PKG_VERSION = "0.0.0-unknown"
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"))
  PKG_VERSION = pkg.version || PKG_VERSION
} catch { /* ignore */ }

export type { CheckResult, DoctorReport, DoctorOptions, Recommendation, AutoFixResult } from "./types"
export type { CheckStatus, Severity, CheckCategory } from "./types"

export async function runDoctor(directory: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  let allChecks: CheckResult[] = []

  // Run all check categories
  const results = await Promise.all([
    runRuntimeChecks(directory),
    runRepositoryChecks(directory),
    runEnvironmentChecks(directory),
    runMCPChecks(directory),
    runPluginChecks(directory),
    runHookChecks(directory),
    runSecurityChecks(directory),
    runConfigurationChecks(directory),
    runBrowserChecks(directory),
    runCuratedSkillChecks(directory),
    runStudioChecks(directory),
    runFdxChecks(directory),
    runFilesystemChecks(directory),
    runHeidiChecks(directory),
  ])

  for (const checks of results) {
    allChecks.push(...checks)
  }

  // Filter by strict mode (only errors and high severity)
  if (options.strict) {
    allChecks = allChecks.filter(c => c.severity === "critical" || c.severity === "high" || c.status === "error")
  }

  // Tally & scores
  let passed = 0
  let warnings = 0
  let errors = 0
  let info = 0
  let skipped = 0
  let repairableCount = 0
  let requiresAuthCount = 0
  let requiresPrivilegeCount = 0
  let manualCount = 0

  let envTotal = 0, envPass = 0, envErr = 0, envWarn = 0
  let secTotal = 0, secPass = 0, secErr = 0, secWarn = 0
  let perfTotal = 0, perfPass = 0, perfErr = 0, perfWarn = 0
  let cfgTotal = 0, cfgPass = 0, cfgErr = 0, cfgWarn = 0

  for (let i = 0; i < allChecks.length; i++) {
    const c = allChecks[i]
    if (c.status === "pass") passed++
    else if (c.status === "warning") warnings++
    else if (c.status === "error") errors++
    else if (c.status === "info") info++
    else if (c.status === "skipped") skipped++

    if (c.autoFixAvailable || c.repairability === "automatic") repairableCount++
    else if (c.repairability === "requires-auth") requiresAuthCount++
    else if (c.repairability === "requires-privilege") requiresPrivilegeCount++
    else if (c.repairability === "manual") manualCount++

    const isPass = c.status === "pass" || c.status === "info"
    const isErr = c.status === "error"
    const isWarn = c.status === "warning"
    const cat = c.category

    if (cat === "runtime" || cat === "environment" || cat === "filesystem") {
      envTotal++
      if (isPass) envPass++
      if (isErr) envErr++
      if (isWarn) envWarn++
    } else if (cat === "security") {
      secTotal++
      if (isPass) secPass++
      if (isErr) secErr++
      if (isWarn) secWarn++
    } else if (cat === "performance") {
      perfTotal++
      if (isPass) perfPass++
      if (isErr) perfErr++
      if (isWarn) perfWarn++
    } else if (cat === "configuration" || cat === "mcp" || cat === "plugin" || cat === "hook" || cat === "lsp" || cat === "fdx" || cat === "browser" || cat === "skills" || cat === "heidi") {
      cfgTotal++
      if (isPass) cfgPass++
      if (isErr) cfgErr++
      if (isWarn) cfgWarn++
    }
  }
  const total = allChecks.length

  // Calculate scores (0-100)
  const calcScore = (tot: number, p: number, e: number, w: number) => {
    if (tot === 0) return 100
    const passRatio = p / tot
    const score = Math.max(0, Math.round(passRatio * 100 - e * 15 - w * 5))
    return Math.min(100, score)
  }

  const envScore = calcScore(envTotal, envPass, envErr, envWarn)
  const secScore = calcScore(secTotal, secPass, secErr, secWarn)
  const perfScore = calcScore(perfTotal, perfPass, perfErr, perfWarn)
  const configScore = calcScore(cfgTotal, cfgPass, cfgErr, cfgWarn)
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
    repairableCount,
    requiresAuthCount,
    requiresPrivilegeCount,
    manualCount,
  }
}

export function scoreCategory(checks: CheckResult[], ...categories: string[]): number {
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
