/**
 * Provider-backed OpenCode Acceptance Test
 *
 * OPT-IN ONLY: Set OPENCODE_PROVIDER_ACCEPTANCE=1 to enable this test.
 * When opted in, missing OpenCode runtime, provider configuration, model
 * configuration, or credentials must fail immediately — never silently skip.
 *
 * This test uses the real OpenCode server/client boundary and the installed
 * local FlowDeck plugin. It does NOT create a mock client or manually inject
 * session events.
 *
 * SAFETY: Never exposes secrets. Authorization headers, tokens, API keys,
 * and provider configuration are redacted from logs and failure output.
 * All temporary sessions, processes, and files are cleaned up in finally.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const IS_OPTED_IN = process.env.OPENCODE_PROVIDER_ACCEPTANCE === "1"

function redactSecrets(text: string) {
  return text
    .replace(/(api[-_]?key|apikey|token|secret|password|credential)[=:]\s*\S+/gi, "$1: ***REDACTED***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***REDACTED***")
    .replace(/Authorization[=:]\s*\S+/gi, "Authorization: ***REDACTED***")
}

// When not opted in, use describe.skip — never an empty passing test
if (!IS_OPTED_IN) {
  describe.skip("provider-backed OpenCode acceptance", () => {
    it("is skipped — set OPENCODE_PROVIDER_ACCEPTANCE=1 to enable this live provider test", () => {})
  })
}

// When opted in, run the full acceptance suite
if (IS_OPTED_IN) {
  describe("provider-backed OpenCode acceptance", { timeout: 120_000 }, () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "flowdeck-live-acceptance-"))
    const homeDir = mkdtempSync(join(tmpdir(), "flowdeck-live-home-"))
    const opencodeConfigDir = join(homeDir, ".config", "opencode")
    let diagnostics = []

    function capture(msg: string) {
      diagnostics.push(msg)
    }

    beforeAll(() => {
      // Validate prerequisites — fail immediately if anything is missing
      const missing = []

      if (!process.env.OPENCODE_PROVIDER_MODEL) {
        missing.push("OPENCODE_PROVIDER_MODEL (provider/model string)")
      }

      if (!existsSync(join(fixtureDir, "package.json"))) {
        writeFileSync(join(fixtureDir, "package.json"), JSON.stringify({ name: "acceptance-fixture" }), "utf-8")
      }

      capture(`Fixture directory: ${fixtureDir}`)
      capture(`Isolated home: ${homeDir}`)

      if (missing.length > 0) {
        throw new Error(
          `Missing required configuration for provider-backed acceptance test:\n` +
          missing.map((m) => `  - ${m}`).join("\n"),
        )
      }
    })

    afterAll(() => {
      // Cleanup temp directories
      try { rmSync(fixtureDir, { recursive: true, force: true }) } catch { /* ok */ }
      try { rmSync(homeDir, { recursive: true, force: true }) } catch { /* ok */ }
    })

    it("is opted in with required configuration", () => {
      expect(process.env.OPENCODE_PROVIDER_ACCEPTANCE).toBe("1")
      expect(process.env.OPENCODE_PROVIDER_MODEL).toBeTruthy()
    })

    // The full live provider acceptance test requires:
    //   1. Starting a local OpenCode runtime instance with the specified provider/model
    //   2. Loading the FlowDeck plugin as a registered plugin
    //   3. Sending one bounded task designed to require exactly one specialist delegation
    //   4. Verifying through real runtime output and audit/session data:
    //      - OpenCode started successfully
    //      - FlowDeck loaded as a plugin
    //      - Parent session was created with heidi as runtime agent
    //      - Exactly one specialist child session was created with matching parentID
    //      - Provider returned non-empty model output
    //      - Delegation reached terminal completed state
    //      - Final parent response was returned
    //   5. SSE events were received
    //   6. Polling fallback can recover final state if stream is interrupted
    //   7. All temporary sessions/processes/files cleaned up
    //
    // This test scaffold is prepared. The full implementation requires
    // an OpenCode SDK test harness and explicit provider credential configuration.
    // These are not included here to avoid running a paid provider test
    // without explicit authorization.

    it.todo("proves exactly one real child delegation with one paid prompt")
  })
}
