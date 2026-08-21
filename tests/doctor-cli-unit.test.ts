import { describe, it, expect } from "bun:test"
import {
  parseArgs,
  resolveBunBinary,
  hasBun,
  redactSecrets,
  buildHumanReport,
  runDoctorCli,
} from "../src/doctor/cli.mjs"

describe("Doctor CLI Unit Tests", () => {
  describe("parseArgs", () => {
    it("handles help flags", () => {
      expect(parseArgs(["--help"])).toEqual({ help: true })
      expect(parseArgs(["-h"])).toEqual({ help: true })
    })

    it("parses valid option flags", () => {
      const res = parseArgs([
        "--json",
        "--strict",
        "--verbose",
        "--apply-recommended",
        "--dry-run",
        "--non-interactive",
        "--profile",
        "ci-strict",
      ])
      expect(res.options).toEqual({
        json: true,
        strict: true,
        verbose: true,
        applyRecommended: true,
        fix: false,
        dryRun: true,
        nonInteractive: true,
        profile: "ci-strict",
      })
    })

    it("parses fix and --fix commands", () => {
      const res1 = parseArgs(["fix"])
      expect(res1.options?.fix).toBe(true)
      expect(res1.options?.applyRecommended).toBe(true)

      const res2 = parseArgs(["--fix"])
      expect(res2.options?.fix).toBe(true)
      expect(res2.options?.applyRecommended).toBe(true)
    })

    it("handles missing --profile value", () => {
      const res = parseArgs(["--profile"])
      expect(res.error).toContain("--profile requires a value")
      expect(res.exitCode).toBe(2)
    })

    it("handles unknown flags", () => {
      const res = parseArgs(["--unknown-flag"])
      expect(res.error).toContain("Unknown flags: --unknown-flag")
      expect(res.exitCode).toBe(2)
      expect(res.usage).toBeTruthy()
    })

    it("handles unexpected non-flag arguments", () => {
      const res = parseArgs(["unexpectedArg"])
      expect(res.error).toContain("Unexpected argument: unexpectedArg")
      expect(res.exitCode).toBe(2)
    })
  })

  describe("resolveBunBinary & hasBun", () => {
    it("resolves bun binary", () => {
      const bin = resolveBunBinary()
      expect(typeof bin === "string" || bin === false).toBe(true)
    })

    it("checks hasBun", () => {
      const hb = hasBun()
      expect(typeof hb).toBe("boolean")
    })
  })

  describe("redactSecrets", () => {
    it("handles primitives and strings", () => {
      expect(redactSecrets("hello world")).toBe("hello world")
      expect(redactSecrets(123)).toBe(123)
      expect(redactSecrets(null)).toBeNull()
      expect(redactSecrets(undefined)).toBeUndefined()
    })

    it("redacts secret keys in objects", () => {
      const obj = {
        api_key: "secret12345",
        token: "token12345",
        password: "pass",
        user_credential: "creds",
        authHeader: "Bearer 123",
        safeKey: "safeValue",
      }
      const redacted = redactSecrets(obj)
      expect(redacted.api_key).toBe("[REDACTED]")
      expect(redacted.token).toBe("[REDACTED]")
      expect(redacted.password).toBe("[REDACTED]")
      expect(redacted.user_credential).toBe("[REDACTED]")
      expect(redacted.authHeader).toBe("[REDACTED]")
      expect(redacted.safeKey).toBe("safeValue")
    })

    it("handles nested arrays and circular references", () => {
      const arr: any[] = ["hello", { token: "secret" }]
      arr.push(arr)
      const redactedArr = redactSecrets(arr)
      expect(redactedArr[0]).toBe("hello")
      expect(redactedArr[1].token).toBe("[REDACTED]")
      expect(redactedArr[2]).toBe("[CIRCULAR]")

      const circularObj: any = { name: "test" }
      circularObj.self = circularObj
      const redactedObj = redactSecrets(circularObj)
      expect(redactedObj.name).toBe("test")
      expect(redactedObj.self).toBe("[CIRCULAR]")
    })

    it("handles max depth", () => {
      let deep: any = { val: "end" }
      for (let i = 0; i < 55; i++) {
        deep = { child: deep }
      }
      const redacted = redactSecrets(deep)
      expect(JSON.stringify(redacted)).toContain("[MAX_DEPTH]")
    })

    it("handles throwing getter objects gracefully", () => {
      const badObj = {}
      Object.defineProperty(badObj, "badProp", {
        get() {
          throw new Error("fail")
        },
        enumerable: true,
      })
      const redacted = redactSecrets(badObj)
      expect(redacted).toBe("[UNSERIALIZABLE]")
    })
  })

  describe("buildHumanReport", () => {
    it("formats comprehensive report for various score ranges and check statuses", () => {
      const report = {
        version: "2.2.7",
        profile: "recommended-dev",
        timestamp: "2026-08-21T00:00:00.000Z",
        summary: {
          total: 25,
          passed: 20,
          warnings: 2,
          errors: 1,
          info: 1,
          skipped: 1,
        },
        scores: {
          environment: 95,
          security: 90,
          performance: 85,
          configuration: 90,
          overall: 90,
        },
        checks: [
          {
            title: "Check Error 1",
            status: "error",
            detected: "Failed critical check",
            recommendation: "Fix immediately",
            autoFixAvailable: true,
          },
          {
            title: "Check Warning 1",
            status: "warning",
            detected: "Minor warning",
            recommendation: "Consider fixing",
          },
          ...Array.from({ length: 25 }, (_, i) => ({
            title: `Check Info ${i}`,
            status: i % 2 === 0 ? "pass" : "info",
            detected: `Details ${i}`,
          })),
        ],
        recommendations: [
          {
            type: "required",
            title: "Required Action",
            description: "Must do this",
            autoFixAvailable: true,
            autoFixCommand: "flowdeck fix",
          },
          {
            type: "recommended",
            title: "Recommended Action",
            description: "Good idea",
          },
          {
            type: "optional",
            title: "Optional Action",
            description: "Optional enhancement",
          },
        ],
      }

      const outNonVerbose = buildHumanReport(report, false)
      expect(outNonVerbose).toContain("FlowDeck Environment Doctor")
      expect(outNonVerbose).toContain("Production Ready")
      expect(outNonVerbose).toContain("ERROR  Check Error 1: Failed critical check")
      expect(outNonVerbose).toContain("Auto-fix available")
      expect(outNonVerbose).toContain("REQUIRED  Required Action")

      const outVerbose = buildHumanReport(report, true)
      expect(outVerbose).toContain("WARN   Check Warning 1: Minor warning")
      expect(outVerbose).toContain("Consider fixing")
      expect(outVerbose).toContain("[Details]")
      expect(outVerbose).toContain("... and 5 more")

      // Test lower score readiness tiers
      expect(buildHumanReport({ scores: { overall: 75 } }, false)).toContain("Mostly Ready")
      expect(buildHumanReport({ scores: { overall: 55 } }, false)).toContain("Needs Work")
      expect(buildHumanReport({ scores: { overall: 30 } }, false)).toContain("Not Ready")
    })
  })

  describe("runDoctorCli", () => {
    it("handles help argument in CLI runner", async () => {
      let stderrOut = ""
      const origWrite = process.stderr.write
      const origExitCode = process.exitCode
      process.stderr.write = ((str: string) => {
        stderrOut += str
        return true
      }) as any
      try {
        await runDoctorCli(["doctor", "--help"])
        expect(stderrOut).toContain("FlowDeck Doctor — Environment Health Checker")
        expect(process.exitCode).toBe(0)
      } finally {
        process.stderr.write = origWrite
        process.exitCode = origExitCode
      }
    })

    it("handles invalid flag argument in CLI runner", async () => {
      let stderrOut = ""
      const origWrite = process.stderr.write
      const origExitCode = process.exitCode
      process.stderr.write = ((str: string) => {
        stderrOut += str
        return true
      }) as any
      try {
        await runDoctorCli(["--invalid-xyz"])
        expect(stderrOut).toContain("Error: Unknown flags: --invalid-xyz")
        expect(process.exitCode).toBe(2)
      } finally {
        process.stderr.write = origWrite
        process.exitCode = origExitCode
      }
    })
  })
})
