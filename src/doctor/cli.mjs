#!/usr/bin/env node
// src/doctor/cli.mjs — FlowDeck Doctor CLI
//
// Standalone CLI entry point for the FlowDeck doctor command.
// Resolves paths relative to the installed package location,
// not process.cwd(), so it works from a globally installed npm package.
//
// Exit codes:
//   0 — Healthy / warnings permitted / safe fixes completed
//   1 — Required checks failed / strict-mode failure / fix failure
//   2 — Invalid arguments / engine error / malformed profile
//
// Usage:
//   flowdeck doctor
//   flowdeck doctor --json
//   flowdeck doctor --strict
//   flowdeck doctor --verbose
//   flowdeck doctor --apply-recommended
//   flowdeck doctor --profile recommended-dev

import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Resolve package root from this file's location:
//   src/doctor/cli.mjs → resolve(../../) = package root
const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..", "..");

// Lazy-import the service (keeps --help fast)
let doctorService = null;
async function getService() {
  if (!doctorService) {
    doctorService = await import("../../scripts/doctor-service.mjs");
  }
  return doctorService;
}

/**
 * Print concise usage to stderr and exit with code 2.
 */
function printUsage() {
  const lines = [
    "",
    "FlowDeck Doctor — Comprehensive Diagnostics",
    "",
    "Usage:",
    "  flowdeck doctor                     Run diagnostics (text output)",
    "  flowdeck doctor --json              JSON output to stdout only",
    "  flowdeck doctor --strict            Fail on warnings (exit 1)",
    "  flowdeck doctor --verbose           Include additional detail",
    "  flowdeck doctor --apply-recommended  Apply safe auto-fixes",
    "  flowdeck doctor --profile <name>    Use a named profile",
    "  flowdeck doctor --help              Show this help",
    "",
    "Profiles:",
    "  recommended-dev   Allow warnings, check core requirements",
    "  ci                Zero-tolerance gate for CI/CD pipelines",
    "",
    "Exit codes:",
    "  0  Healthy / warnings tolerated / fixes completed",
    "  1  Required checks failed / strict-mode violation",
    "  2  Invalid arguments / engine error / unknown profile",
    "",
  ];
  for (const line of lines) {
    process.stderr.write(line + "\n");
  }
}

/**
 * Parse CLI arguments.
 *
 * @param {string[]} args - Raw argument array (e.g. process.argv.slice(3) for "flowdeck doctor ...")
 * @returns {{ ok: boolean, options: object, error?: string }}
 */
function parseArgs(args) {
  const options = {
    json: false,
    strict: false,
    verbose: false,
    applyRecommended: false,
    profile: null,
    help: false,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    switch (arg) {
      case "--json":
        options.json = true;
        i++;
        break;

      case "--strict":
        options.strict = true;
        i++;
        break;

      case "--verbose":
        options.verbose = true;
        i++;
        break;

      case "--apply-recommended":
        options.applyRecommended = true;
        i++;
        break;

      case "--profile":
        i++;
        if (i >= args.length) {
          return { ok: false, options: null, error: "--profile requires a value" };
        }
        options.profile = args[i];
        i++;
        break;

      case "--help":
      case "-h":
        options.help = true;
        i++;
        break;

      default:
        if (arg.startsWith("--")) {
          return { ok: false, options: null, error: `Unknown flag: ${arg}` };
        }
        // Positional argument — ignore
        i++;
        break;
    }
  }

  return { ok: true, options };
}

/**
 * Main CLI entry point.
 *
 * @param {string[]} rawArgs - Full process.argv slice (e.g. ["doctor", "--json"])
 */
export async function runDoctorCli(rawArgs) {
  // Strip leading "doctor" command if present
  const args = rawArgs[0] === "doctor" ? rawArgs.slice(1) : rawArgs;

  // Parse
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`Error: ${parsed.error}\n`);
    printUsage();
    process.exitCode = 2; // EXIT_ERROR
    return;
  }

  if (parsed.options.help) {
    printUsage();
    process.exitCode = 0;
    return;
  }

  // Verify package root exists
  if (!existsSync(join(PKG_ROOT, "package.json"))) {
    process.stderr.write(
      `Error: Cannot locate FlowDeck package from ${PKG_ROOT}\n`
    );
    process.exitCode = 2;
    return;
  }

  // Run the service
  const service = await getService();
  const result = await service.runDoctorService(PKG_ROOT, parsed.options);

  // Write output
  if (result.stdout) {
    if (parsed.options.json) {
      // JSON goes to stdout only
      process.stdout.write(result.stdout);
    } else {
      // Text output goes to stdout
      process.stdout.write(result.stdout);
    }
  }

  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  process.exitCode = result.exitCode;
}

// ── Self-execution when run directly ─────────────────────────────────────
// Allows: node src/doctor/cli.mjs doctor --help
// and:    node src/doctor/cli.mjs doctor --json
const isMainModule = process.argv[1] && (
  fileURLToPath(import.meta.url) === resolve(process.argv[1]) ||
  fileURLToPath(import.meta.url).replace(/\\/g, "/") === resolve(process.argv[1]).replace(/\\/g, "/")
);
if (isMainModule) {
  // process.argv = ["node", "cli.mjs", "doctor", "--json", ...]
  const doctorArgs = process.argv.slice(2); // ["doctor", "--json", ...]
  runDoctorCli(doctorArgs).catch((err) => {
    process.stderr.write(`Fatal error: ${err.message}\n`);
    process.exit(2);
  });
}
