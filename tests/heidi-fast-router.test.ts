import { describe, it, expect } from "bun:test"
import {
  classifyTask,
  shouldSkipSpecialistDirectory,
  getRequiredSpecialistDomains,
} from "../src/services/heidi-fast-router"

describe("HeidiFastRouter — Milestone B", () => {
  // Required 1: FAST_DIRECT classification
  it("classifies a typo fix as FAST_DIRECT", () => {
    const d = classifyTask("fix a typo in the README")
    expect(d.executionClass).toBe("FAST_DIRECT")
    expect(d.confidence).toBeGreaterThan(0.7)
  })

  it("classifies a single-file config change as FAST_DIRECT", () => {
    const d = classifyTask("small config change to update the timeout value")
    expect(d.executionClass).toBe("FAST_DIRECT")
  })

  it("classifies a variable rename as FAST_DIRECT", () => {
    const d = classifyTask("rename the variable handleClick to onButtonPress")
    expect(d.executionClass).toBe("FAST_DIRECT")
  })

  it("classifies a minor tweak as FAST_DIRECT", () => {
    const d = classifyTask("minor tweak to the error message string")
    expect(d.executionClass).toBe("FAST_DIRECT")
  })

  // Required 2: SPECIALIST — debugger routing
  it("classifies failing test diagnosis as SPECIALIST with DEBUG domain", () => {
    const d = classifyTask("the failing test TestUserAuth is red, find the root cause")
    expect(d.executionClass).toBe("SPECIALIST")
    expect(d.specialists).toContain("DEBUG")
    expect(d.suggestedAgents).toContain("debug-specialist")
  })

  it("classifies debug investigation as SPECIALIST with DEBUG", () => {
    const d = classifyTask("debug why the auth middleware throws a runtime error")
    expect(d.executionClass).toBe("SPECIALIST")
    expect(d.specialists).toContain("DEBUG")
  })

  // Required 3: SPECIALIST — security specialist immediate routing
  it("classifies security audit as SPECIALIST with SECURITY", () => {
    const d = classifyTask("security audit of the authentication module")
    expect(d.executionClass).toBe("SPECIALIST")
    expect(d.specialists).toContain("SECURITY")
    expect(d.suggestedAgents).toContain("security-auditor")
  })

  it("classifies vulnerability scan as SPECIALIST with SECURITY", () => {
    const d = classifyTask("perform a vulnerability assessment of the login flow")
    expect(d.executionClass).toBe("SPECIALIST")
    expect(d.specialists).toContain("SECURITY")
  })

  // Required 4: SPECIALIST — UI specialist immediate routing
  it("classifies frontend UI work as SPECIALIST with UI", () => {
    const d = classifyTask("build a React component for the user dashboard UI")
    expect(d.executionClass).toBe("SPECIALIST")
    expect(d.specialists).toContain("UI")
    expect(d.suggestedAgents).toContain("frontend-coder")
  })

  it("classifies landing page design as SPECIALIST with UI", () => {
    const d = classifyTask("create a new landing page with Tailwind CSS responsive layout")
    expect(d.executionClass).toBe("SPECIALIST")
    expect(d.specialists).toContain("UI")
  })

  // Required 5: PARALLEL_SPECIALISTS for independent domains
  it("classifies frontend+backend independent task as PARALLEL_SPECIALISTS", () => {
    const d = classifyTask("implement frontend UI components and backend API endpoints in parallel")
    expect(d.executionClass).toBe("PARALLEL_SPECIALISTS")
    expect(d.specialists).toBeDefined()
    expect(d.specialists!.length).toBeGreaterThanOrEqual(2)
  })

  it("classifies simultaneously frontend+backend as PARALLEL_SPECIALISTS", () => {
    const d = classifyTask("simultaneously build the React UI and the REST API")
    expect(d.executionClass).toBe("PARALLEL_SPECIALISTS")
  })

  // DEEP classification
  it("classifies architecture migration as DEEP with bounded multi-specialist execution", () => {
    const d = classifyTask("Migrate the entire application architecture from REST to GraphQL")
    expect(d.executionClass).toBe("DEEP")
    expect(d.executionMode).toBe("MULTI_SPECIALIST")
    expect(d.specialists).toEqual(["ARCHITECTURE", "REVIEW"])
    expect(d.reasonCode).toBe("MULTI_DEEP_MIGRATION")
  })

  it("classifies breaking API redesign as DEEP", () => {
    const d = classifyTask("breaking API redesign for the v3 major release")
    expect(d.executionClass).toBe("DEEP")
    expect(d.executionMode).toBe("MULTI_SPECIALIST")
    expect(d.specialists).toEqual(["ARCHITECTURE", "REVIEW"])
  })

  // STANDARD classification
  it("classifies multi-file feature implementation as STANDARD", () => {
    const d = classifyTask("implement a new user onboarding workflow across several files")
    expect(d.executionClass).toBe("STANDARD")
  })

  it("classifies refactor as STANDARD", () => {
    const d = classifyTask("refactor the authentication service to use the new token model")
    expect(d.executionClass).toBe("STANDARD")
  })

  // Required 6: FAST_DIRECT skips specialist directory
  it("shouldSkipSpecialistDirectory returns true for FAST_DIRECT", () => {
    expect(shouldSkipSpecialistDirectory("FAST_DIRECT")).toBe(true)
  })

  it("shouldSkipSpecialistDirectory returns false for SPECIALIST", () => {
    expect(shouldSkipSpecialistDirectory("SPECIALIST")).toBe(false)
  })

  it("shouldSkipSpecialistDirectory returns false for STANDARD", () => {
    expect(shouldSkipSpecialistDirectory("STANDARD")).toBe(false)
  })

  // Required 7: Specialist domain injection
  it("getRequiredSpecialistDomains returns empty for FAST_DIRECT", () => {
    const d = classifyTask("fix typo")
    d.executionClass = "FAST_DIRECT"
    expect(getRequiredSpecialistDomains(d)).toEqual([])
  })

  it("getRequiredSpecialistDomains returns specific domains for SPECIALIST", () => {
    const d = classifyTask("security audit")
    const domains = getRequiredSpecialistDomains(d)
    expect(domains).toContain("SECURITY")
  })

  it("provides a reason string for every classification", () => {
    const cases = [
      "fix typo",
      "security audit",
      "build React dashboard UI",
      "implement new API",
      "architecture migration",
    ]
    for (const c of cases) {
      const d = classifyTask(c)
      expect(typeof d.reason).toBe("string")
      expect(d.reason.length).toBeGreaterThan(0)
    }
  })

  it("keeps a long but bounded version question DIRECT", () => {
    const d = classifyTask("Please carefully read package.json and tell me what PostgreSQL version is configured. The surrounding release context is informational only and does not request changes, delegation, or investigation.")
    expect(d.executionClass).toBe("FAST_DIRECT")
    expect(d.executionMode).toBe("DIRECT")
    expect(d.reasonCode).toBe("DIRECT_SCOPED_QUERY")
  })

  it("escalates a short cross-domain authentication race to MULTI_SPECIALIST", () => {
    const d = classifyTask("Fix auth race across API DB UI.")
    expect(d.executionClass).toBe("PARALLEL_SPECIALISTS")
    expect(d.executionMode).toBe("MULTI_SPECIALIST")
    expect(d.specialists).toContain("DEBUG")
    expect(d.specialists).toContain("UI")
    expect(d.specialists).toContain("BACKEND")
  })

  it("respects an explicit direct-execution request", () => {
    const d = classifyTask("Do this yourself: investigate the failing test.")
    expect(d.executionClass).toBe("FAST_DIRECT")
    expect(d.executionMode).toBe("DIRECT")
    expect(d.reasonCode).toBe("USER_REQUESTED_DIRECT")
    expect(d.forcedByExplicitSignal).toBe(true)
  })

  it("respects an explicit single-specialist request", () => {
    const d = classifyTask("Delegate this security audit to a specialist.")
    expect(d.executionClass).toBe("SPECIALIST")
    expect(d.executionMode).toBe("SINGLE_SPECIALIST")
    expect(d.specialists).toEqual(["SECURITY"])
    expect(d.reasonCode).toBe("USER_REQUESTED_SPECIALIST")
  })

  it("respects an explicit bounded multi-specialist request", () => {
    const d = classifyTask("Use multiple agents for the frontend and backend changes.")
    expect(d.executionClass).toBe("PARALLEL_SPECIALISTS")
    expect(d.executionMode).toBe("MULTI_SPECIALIST")
    expect(d.reasonCode).toBe("USER_REQUESTED_MULTI_SPECIALIST")
  })
})
