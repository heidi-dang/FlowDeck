/**
 * Canonical Sensitive-Path Protection Service
 *
 * Provides a single authoritative source of truth for sensitive-file
 * and sensitive-path patterns across all FlowDeck execution surfaces:
 * - Direct file read tools (read, read_file, fdx-read)
 * - Shell command inspection / execution
 * - FDX redirects and native fallbacks
 */

import { homedir } from "os"
import { normalize, resolve } from "path"

/**
 * Standard Unix pseudo-devices that are unconditionally benign output sinks.
 * Redirects to these paths (2>/dev/null, >/dev/null, 1>/dev/stderr, etc.)
 * must never trigger the /dev/ sensitive-path pattern.
 */
export const BENIGN_PSEUDO_DEVICES: ReadonlySet<string> = new Set([
  "/dev/null",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/zero",
  "/dev/full",
  "/dev/tty",
  "/dev/ptmx",
  "/dev/urandom",
  "/dev/random",
])

/**
 * Regex that matches shell redirections pointing to a benign pseudo-device.
 * Handles forms: 2>/dev/null  >/dev/null  1>/dev/null  >>/dev/null  2>&1  >/dev/stderr
 * Used to strip these tokens before sensitive-path scanning of a command string.
 */
const BENIGN_REDIRECT_RE =
  /\s*[0-9]*>{1,2}&?[0-9]*\s*\/dev\/(null|stdin|stdout|stderr|zero|full|tty|ptmx|urandom|random)\b/g

/**
 * Strip benign pseudo-device redirections from a shell command string so that
 * patterns like 2>/dev/null do not incorrectly match the /dev/ sensitive pattern.
 * Only removes benign pseudo-device targets; all other /dev/ paths remain intact.
 */
export function stripBenignPseudoDeviceRedirects(cmd: string): string {
  return cmd.replace(BENIGN_REDIRECT_RE, "")
}

/** Default sensitive-path patterns. Substring match (case-insensitive). */
export const DEFAULT_SENSITIVE_PATTERNS: ReadonlyArray<string> = [
  ".env",
  ".envrc",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".aws/credentials",
  ".aws/config",
  ".gcp/credentials",
  ".config/gcloud",
  ".kube/config",
  ".docker/config.json",
  ".ssh/",
  ".gnupg/",
  ".pki/",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  "authorized_keys",
  "known_hosts",
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".secret",
  ".keystore",
  "credentials",
  "credentials.json",
  "service-account",
  "service_account",
  "secrets.",
  "secrets/",
  "/etc/passwd",
  "/etc/shadow",
  "/etc/sudoers",
  "/etc/ssh/",
  "/proc/",
  "/sys/",
  "/dev/",
]

/**
 * Check if a given file path points to a sensitive file or directory.
 * Evaluates both raw path string and resolved canonical path against the project root.
 *
 * Returns the matched pattern name if sensitive, or null if benign.
 */
export function checkSensitivePath(
  filePath: string,
  projectDir?: string,
  extraPatterns?: ReadonlyArray<string>
): string | null {
  if (!filePath || typeof filePath !== "string") return null

  // Exact benign pseudo-device paths are never sensitive, even though they live under /dev/.
  const normalizedInput = filePath.replace(/\\/g, "/").trim()
  if (BENIGN_PSEUDO_DEVICES.has(normalizedInput)) return null

  const patterns =
    extraPatterns && extraPatterns.length > 0
      ? [...DEFAULT_SENSITIVE_PATTERNS, ...extraPatterns]
      : DEFAULT_SENSITIVE_PATTERNS

  const rawNormalized = filePath.replace(/\\/g, "/")
  const rawLower = rawNormalized.toLowerCase()

  for (const p of patterns) {
    const pLower = p.toLowerCase()
    if (rawLower.includes(pLower)) {
      return p
    }
  }

  const baseCwd = projectDir || process.cwd()

  try {
    let resolved = filePath
    if (filePath === "~" || filePath.startsWith("~/")) {
      resolved = filePath === "~" ? homedir() : resolve(homedir(), filePath.slice(2))
    } else {
      resolved = resolve(baseCwd, filePath)
    }
    const resolvedNormalized = normalize(resolved).replace(/\\/g, "/").toLowerCase()
    for (const p of patterns) {
      const pLower = p.toLowerCase()
      if (resolvedNormalized.includes(pLower)) {
        return p
      }
    }
  } catch {
    // Ignore resolution errors
  }

  return null
}
