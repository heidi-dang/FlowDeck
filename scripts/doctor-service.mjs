#!/usr/bin/env node
// scripts/doctor-service.mjs — Doctor Service Bridge
//
// Wraps the authoritative doctor-engine.mjs with:
// - JSON/text output formatting
// - Strict-mode policy enforcement
// - Profile-based check filtering
// - --apply-recommended (safe auto-fixes)
// - Secret redaction
// - Package-relative path resolution
//
// Used by:
//   - bin/flowdeck.js (CLI doctor command)
//   - src/doctor/cli.mjs (standalone CLI handler)
//   - install.sh (pre/post-install verification)

import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runDoctorChecks } from "./doctor-engine.mjs";

// ── Constants ────────────────────────────────────────────────────────────

export const SCHEMA_VERSION = 1;
export const EXIT_HEALTHY = 0;
export const EXIT_FAILURE = 1;
export const EXIT_ERROR = 2;

// ── Secret patterns (never expose in any output) ────────────────────────

const SECRET_PATTERNS = [
  /(api[_-]?key|apikey|token|secret|password|credential)[=:]\s*\S+/gi,
  /(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,
  /(-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----)[\s\S]*?(-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----)/g,
  /(?:https?:\/\/)?[\w.-]+@[\w.-]+\.\w{2,}(?::\d+)?[/~][\w./-]+/g,
];

const SECRET_REPLACEMENT = "[REDACTED]";

/**
 * Redact known secret patterns from a string.
 * Returns the redacted string.
 */
function redactSecrets(text) {
  if (typeof text !== "string") return text;
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // Keep the key prefix visible, redact the value part
      const colonIdx = match.indexOf(":");
      const eqIdx = match.indexOf("=");
      const sepIdx = colonIdx > 0 ? colonIdx : eqIdx > 0 ? eqIdx : -1;
      if (sepIdx > 0 && sepIdx < match.length - 1) {
        return match.slice(0, sepIdx + 1) + SECRET_REPLACEMENT;
      }
      return SECRET_REPLACEMENT;
    });
  }
  return result;
}

/**
 * Deep-redact an object (recursively).
 */
function deepRedact(obj) {
  if (typeof obj === "string") return redactSecrets(obj);
  if (Array.isArray(obj)) return obj.map(deepRedact);
  if (obj && typeof obj === "object") {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = deepRedact(value);
    }
    return result;
  }
  return obj;
}

// ── Profiles ─────────────────────────────────────────────────────────────

const PROFILES = {
  "recommended-dev": {
    description: "Recommended for local development",
    minPassRate: 0.7, // Allow up to 30% warning/fail
    strict: false,
    requiredChecks: ["pkg.identity", "pkg.version", "config.validity"],
  },
  ci: {
    description: "CI/CD pipeline gate",
    minPassRate: 1.0,
    strict: true,
    requiredChecks: [
      "pkg.identity",
      "pkg.version",
      "config.validity",
      "agents.count",
      "delegation.depth",
      "governance.wiring",
    ],
  },
};

function getProfile(name) {
  if (!name) return null;
  return PROFILES[name] || null;
}

// ── Safe auto-fixes (--apply-recommended) ────────────────────────────────

/**
 * Apply safe, idempotent fixes for remediable check failures.
 * Returns { fixed: number, failed: number, details: Array<{checkId, status, message}> }.
 */
async function applyRecommendedFixes(directory, report) {
  const fixes = [];
  for (const check of report.checks) {
    if (check.status !== "fail") continue;

    const fix = await tryFixCheck(directory, check);
    if (fix) {
      fixes.push({ checkId: check.id, status: fix.status, message: fix.message });
    }
  }

  const fixed = fixes.filter((f) => f.status === "fixed").length;
  const failed = fixes.filter((f) => f.status === "failed").length;
  return { fixed, failed, details: fixes };
}

/**
 * Attempt a single safe, idempotent fix for a check.
 * Returns null if no fix is available or the fix is not safe to auto-apply.
 */
async function tryFixCheck(directory, check) {
  switch (check.id) {
    case "config.registration": {
      // If flowdeck is not registered, attempt install
      if (check.message.includes("not registered") || check.message.includes("Upstream")) {
        try {
          // Import and run the install command
          const { executeTransaction } = await import("./config-transaction.mjs");
          const configDir = resolveConfigDir();
          mkdirSync(configDir, { recursive: true });

          const configPath = join(configDir, "opencode.json");
          const manifestPath = join(configDir, ".flowdeck-manifest.json");

          const result = await executeTransaction({
            configPath,
            edits: [
              {
                path: ["plugin"],
                value: ["@heidi-dang/flowdeck"],
              },
              {
                path: ["default_agent"],
                value: "heidi",
              },
            ],
            manifest: {
              schemaVersion: 2,
              pluginRef: "@heidi-dang/flowdeck",
              pluginAdded: true,
              installationMode: "postinstall",
              version: readPackageVersion(directory),
            },
            manifestPath,
          });

          if (result.ok) {
            return { status: "fixed", message: "Registered @heidi-dang/flowdeck in config" };
          }
          return { status: "failed", message: `Auto-registration failed: ${result.error}` };
        } catch (err) {
          return { status: "failed", message: `Auto-registration error: ${err.message}` };
        }
      }
      return null;
    }

    case "config.validity": {
      // Can't auto-fix malformed config
      return null;
    }

    default:
      return null; // No safe auto-fix for this check
  }
}

function readPackageVersion(directory) {
  try {
    const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

// ── Report formatting ────────────────────────────────────────────────────

/**
 * Format a doctor report as human-readable text.
 */
function formatTextReport(report, options = {}) {
  const lines = [];
  const { verbose = false } = options;

  lines.push(`FlowDeck Doctor — Comprehensive Diagnostics`);
  lines.push(`Schema: v${SCHEMA_VERSION}`);
  lines.push(`Package: ${report.packageName || "@heidi-dang/flowdeck"}`);
  lines.push(`Version: ${report.packageVersion || "unknown"}`);
  lines.push("");

  if (report.directory) {
    lines.push(`Directory: ${report.directory}`);
    lines.push("");
  }

  lines.push("── Diagnostics ──");
  for (const check of report.checks) {
    const icon = check.status === "pass" ? "\u2713" : check.status === "warn" ? "\u26A0" : "\u2717";
    let msg = check.message || "";
    if (!verbose) {
      // Truncate long messages in non-verbose mode
      if (msg.length > 120) msg = msg.slice(0, 117) + "...";
    }
    lines.push(` ${icon} ${check.name}: ${msg}`);
    if (check.remediation) {
      lines.push(`    Remedy: ${check.remediation}`);
    }
  }

  lines.push("");
  lines.push("── Summary ──");
  lines.push(`  Passed: ${report.passed}`);
  lines.push(`  Warned: ${report.warned}`);
  lines.push(`  Failed: ${report.failed}`);
  lines.push(`  Status: ${report.failed > 0 ? "UNHEALTHY" : report.warned > 0 ? "DEGRADED" : "HEALTHY"}`);

  if (report.appliedFixes) {
    lines.push("");
    lines.push("── Applied Fixes ──");
    for (const fix of report.appliedFixes.details) {
      const icon = fix.status === "fixed" ? "\u2713" : "\u2717";
      lines.push(` ${icon} ${fix.checkId}: ${fix.message}`);
    }
    lines.push(`  Fixed: ${report.appliedFixes.fixed}, Failed: ${report.appliedFixes.failed}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Format a doctor report as JSON.
 */
function formatJsonReport(report) {
  const output = {
    schemaVersion: SCHEMA_VERSION,
    packageName: report.packageName || "@heidi-dang/flowdeck",
    packageVersion: report.packageVersion || "unknown",
    directory: report.directory || null,
    passed: report.passed,
    warned: report.warned,
    failed: report.failed,
    status: report.failed > 0 ? "unhealthy" : report.warned > 0 ? "degraded" : "healthy",
    checks: report.checks.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      message: c.message,
      ...(c.remediation ? { remediation: c.remediation } : {}),
    })),
  };

  if (report.appliedFixes) {
    output.appliedFixes = {
      fixed: report.appliedFixes.fixed,
      failed: report.appliedFixes.failed,
      details: report.appliedFixes.details,
    };
  }

  return JSON.stringify(output, null, 2) + "\n";
}

// ── Resolve config directory ─────────────────────────────────────────────

function resolveConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "opencode");
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".config", "opencode");
}

// ── Main service API ─────────────────────────────────────────────────────

/**
 * Run the doctor service with full CLI support.
 *
 * @param {string} directory - Package root directory
 * @param {object} options
 * @param {boolean} [options.json] - Output JSON (default false)
 * @param {boolean} [options.strict] - Fail on warnings (default false)
 * @param {boolean} [options.verbose] - Include additional detail (default false)
 * @param {boolean} [options.applyRecommended] - Apply safe auto-fixes (default false)
 * @param {string} [options.profile] - Named profile to use (default null)
 * @returns {Promise<{ report: object, exitCode: number, stdout: string, stderr: string }>}
 */
export async function runDoctorService(directory, options = {}) {
  const {
    json = false,
    strict = false,
    verbose = false,
    applyRecommended = false,
    profile = null,
  } = options;

  const stderrLog = [];
  const logError = (msg) => stderrLog.push(msg);

  // Resolve the profile
  let effectiveStrict = strict;
  let effectiveRequired = null;
  if (profile) {
    const resolved = getProfile(profile);
    if (!resolved) {
      logError(`Unknown profile: "${profile}"`);
      return {
        report: null,
        exitCode: EXIT_ERROR,
        stdout: "",
        stderr: stderrLog.join("\n") + (stderrLog.length > 0 ? "\n" : ""),
      };
    }
    if (resolved.strict) effectiveStrict = true;
    effectiveRequired = resolved.requiredChecks || null;
  }

  // Validate directory
  if (!existsSync(join(directory, "package.json"))) {
    logError(`Invalid FlowDeck directory: ${directory}`);
    return {
      report: null,
      exitCode: EXIT_ERROR,
      stdout: "",
      stderr: stderrLog.join("\n") + (stderrLog.length > 0 ? "\n" : ""),
    };
  }

  let report;
  try {
    report = await runDoctorChecks(directory);
  } catch (err) {
    logError(`Doctor engine error: ${err.message}`);
    return {
      report: null,
      exitCode: EXIT_ERROR,
      stdout: "",
      stderr: stderrLog.join("\n") + (stderrLog.length > 0 ? "\n" : ""),
    };
  }

  // Apply recommended fixes if requested
  let appliedFixes = null;
  if (applyRecommended) {
    try {
      appliedFixes = await applyRecommendedFixes(directory, report);
      // Re-run checks after fixes
      report = await runDoctorChecks(directory);
    } catch (err) {
      logError(`Auto-fix error: ${err.message}`);
    }
  }

  // Build the report envelope
  const pkgVersion = readPackageVersion(directory);
  const fullReport = {
    ...report,
    packageName: "@heidi-dang/flowdeck",
    packageVersion: pkgVersion,
    directory,
    appliedFixes,
  };

  // Profile-based requirement check
  let profileFailed = false;
  if (effectiveRequired) {
    for (const checkId of effectiveRequired) {
      const check = report.checks.find((c) => c.id === checkId);
      if (!check || check.status === "fail") {
        profileFailed = true;
        break;
      }
    }
  }

  // Determine exit code
  let exitCode;
  if (effectiveStrict || profileFailed) {
    exitCode = report.failed > 0 || (effectiveStrict && report.warned > 0) || profileFailed
      ? EXIT_FAILURE
      : EXIT_HEALTHY;
  } else {
    exitCode = report.failed > 0 ? EXIT_FAILURE : EXIT_HEALTHY;
  }

  // Format output
  const redactedReport = deepRedact(fullReport);
  let stdout;
  if (json) {
    stdout = formatJsonReport(redactedReport);
  } else {
    stdout = formatTextReport(redactedReport, { verbose });
  }

  return {
    report: redactedReport,
    exitCode,
    stdout,
    stderr: stderrLog.join("\n") + (stderrLog.length > 0 ? "\n" : ""),
  };
}
