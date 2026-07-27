import { describe, it, expect } from "vitest"
import {
  parsePrePushStdin,
  detectRustChangesFromRefs,
  detectRustChanges,
  getRequiredSteps,
} from "../scripts/pre-push.mjs"

describe("Pre-Push Gate & Rust Change Detection Unit Tests (tests/pre-push.test.ts)", () => {
  describe("parsePrePushStdin", () => {
    it("returns empty array for absent or empty stdin input", () => {
      expect(parsePrePushStdin(undefined)).toEqual([])
      expect(parsePrePushStdin("")).toEqual([])
      expect(parsePrePushStdin("   \n")).toEqual([])
    })

    it("parses valid single pre-push ref line", () => {
      const stdin = "refs/heads/main 1111111111111111111111111111111111111111 refs/heads/main 2222222222222222222222222222222222222222\n"
      const res = parsePrePushStdin(stdin)
      expect(res).toHaveLength(1)
      expect(res[0]).toEqual({
        localRef: "refs/heads/main",
        localSha: "1111111111111111111111111111111111111111",
        remoteRef: "refs/heads/main",
        remoteSha: "2222222222222222222222222222222222222222",
      })
    })

    it("parses multiple pre-push ref lines", () => {
      const stdin = `
refs/heads/feature-a AAA AAA refs/heads/feature-a BBB
refs/heads/feature-b CCC CCC refs/heads/feature-b DDD
`
      const res = parsePrePushStdin(stdin)
      expect(res).toHaveLength(2)
      expect(res[0].localRef).toBe("refs/heads/feature-a")
      expect(res[1].localRef).toBe("refs/heads/feature-b")
    })

    it("fails closed on malformed stdin ref line with fewer than 4 tokens", () => {
      const malformed = "refs/heads/main 111 222\n"
      expect(() => parsePrePushStdin(malformed)).toThrow(/Malformed pre-push stdin ref line/)
    })
  })

  describe("detectRustChangesFromRefs", () => {
    it("returns null when no ref entries are provided", () => {
      expect(detectRustChangesFromRefs([])).toBeNull()
      expect(detectRustChangesFromRefs(null as any)).toBeNull()
    })

    it("detects existing branch without Rust changes", () => {
      const headSha = "bdd9951393a5b2039c7e287152c1ef55d4629c27"
      const entries = [{ localRef: "ref", localSha: headSha, remoteRef: "ref", remoteSha: headSha }]
      const res = detectRustChangesFromRefs(entries)
      expect(res).toBe(false)
    })

    it("detects existing branch with Rust change via ref comparison", () => {
      // Commit 5bfc649 modified crates/fdx/src/main.rs vs 5bfc649~1
      const prevSha = "5bfc649~1"
      const rustSha = "5bfc649"
      const entries = [{ localRef: "ref", localSha: rustSha, remoteRef: "ref", remoteSha: prevSha }]
      const res = detectRustChangesFromRefs(entries)
      expect(res).toBe(true)
    })

    it("handles new branch (all zero remote SHA) conservatively", () => {
      const zeroSha = "0000000000000000000000000000000000000000"
      const currentSha = "bdd9951393a5b2039c7e287152c1ef55d4629c27"
      const entries = [{ localRef: "ref", localSha: currentSha, remoteRef: "ref", remoteSha: zeroSha }]
      const res = detectRustChangesFromRefs(entries)
      expect(typeof res).toBe("boolean")
    })

    it("detects Rust changes across multiple pushed refs when one ref contains Rust changes", () => {
      const headSha = "bdd9951393a5b2039c7e287152c1ef55d4629c27"
      const rustSha = "5bfc649"
      const prevSha = "5bfc649~1"
      const entries = [
        { localRef: "ref1", localSha: headSha, remoteRef: "ref1", remoteSha: headSha },
        { localRef: "ref2", localSha: rustSha, remoteRef: "ref2", remoteSha: prevSha },
      ]
      const res = detectRustChangesFromRefs(entries)
      expect(res).toBe(true)
    })
  })

  describe("detectRustChanges Fail-Closed Policy", () => {
    it("returns true on invalid directory path or git error (fail-closed)", () => {
      const res = detectRustChanges("", "/nonexistent_path_for_testing_12345")
      expect(res).toBe(true)
    })

    it("returns true on malformed stdin ref input (fail-closed)", () => {
      const res = detectRustChanges("invalid stdin data line")
      expect(res).toBe(true)
    })

    it("returns false on clean working directory when upstream comparison proves no Rust changes", () => {
      const res = detectRustChanges("")
      expect(res).toBe(false)
    })
  })

  describe("getRequiredSteps & Rust Command Assembly", () => {
    it("returns standard JavaScript/TypeScript gates when no Rust changes detected", () => {
      const steps = getRequiredSteps(false, false)
      expect(steps).toHaveLength(8)
      expect(steps.some((s) => s.name.startsWith("Rust"))).toBe(false)
    })

    it("adds all four Rust commands when Rust changes are detected and Cargo is available", () => {
      const steps = getRequiredSteps(true, true)
      expect(steps).toHaveLength(12)
      const rustSteps = steps.filter((s) => s.name.startsWith("Rust"))
      expect(rustSteps).toHaveLength(4)
      expect(rustSteps[0].name).toBe("Rust Formatting")
      expect(rustSteps[0].cmd).toContain("cargo fmt")
      expect(rustSteps[1].name).toBe("Rust Clippy")
      expect(rustSteps[1].cmd).toContain("cargo clippy")
      expect(rustSteps[2].name).toBe("Rust Tests")
      expect(rustSteps[2].cmd).toContain("cargo test")
      expect(rustSteps[3].name).toBe("Rust Build")
      expect(rustSteps[3].cmd).toContain("cargo build")
    })

    it("fails closed (throws Error) when Rust changes are detected but Cargo is not installed", () => {
      expect(() => getRequiredSteps(true, false)).toThrow(/Cargo is not installed on PATH. Push blocked/)
    })
  })
})
