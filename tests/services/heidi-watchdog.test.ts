import { describe, it, expect, beforeEach } from "vitest"
import {
  updateWatchdogState,
  getWatchdogState,
  clearAllWatchdogStates,
  isWatchdogEligible,
} from "../../src/services/heidi-watchdog"
import { watchdogIncidentManager } from "../../src/services/watchdog-incident"

describe("heidi-watchdog & isWatchdogEligible matrix", () => {
  beforeEach(() => {
    clearAllWatchdogStates()
    watchdogIncidentManager.clearAll()
  })

  it("matrix item 1: active + runnable + stalled -> ELIGIBLE (true)", () => {
    updateWatchdogState("ses_1", {
      hasUnresolvedTask: true,
      isActiveSession: true,
      isTerminalTask: false,
      isPendingProvider: false,
      isPendingTool: false,
      isPendingChild: false,
      isPendingContinuation: false,
      isPendingUser: false,
    })
    const state = getWatchdogState("ses_1")
    expect(isWatchdogEligible(state)).toBe(true)
  })

  it("matrix item 2: active + currently making progress (pending tool/provider/child/continuation) -> INELIGIBLE (false)", () => {
    updateWatchdogState("ses_2", {
      hasUnresolvedTask: true,
      isActiveSession: true,
      isPendingTool: true,
    })
    expect(isWatchdogEligible(getWatchdogState("ses_2"))).toBe(false)

    updateWatchdogState("ses_2", { isPendingTool: false, isPendingContinuation: true })
    expect(isWatchdogEligible(getWatchdogState("ses_2"))).toBe(false)
  })

  it("matrix item 3: completed -> INELIGIBLE (false)", () => {
    updateWatchdogState("ses_3", {
      hasUnresolvedTask: false,
      isActiveSession: false,
      isTerminalTask: true,
    })
    expect(isWatchdogEligible(getWatchdogState("ses_3"))).toBe(false)
  })

  it("matrix item 4: inactive / idle -> INELIGIBLE (false)", () => {
    updateWatchdogState("ses_4", {
      hasUnresolvedTask: false,
      isActiveSession: false,
    })
    expect(isWatchdogEligible(getWatchdogState("ses_4"))).toBe(false)
  })

  it("matrix item 5: cancelled -> INELIGIBLE (false)", () => {
    updateWatchdogState("ses_5", {
      hasUnresolvedTask: false,
      isTerminalTask: true,
      isActiveSession: false,
    })
    expect(isWatchdogEligible(getWatchdogState("ses_5"))).toBe(false)
  })

  it("matrix item 6: failed-final -> INELIGIBLE (false)", () => {
    updateWatchdogState("ses_6", {
      hasUnresolvedTask: false,
      isTerminalTask: true,
      isActiveSession: false,
    })
    expect(isWatchdogEligible(getWatchdogState("ses_6"))).toBe(false)
  })

  it("matrix item 7: recovery exhausted (STALLED_UNRECOVERED) -> INELIGIBLE (false)", () => {
    updateWatchdogState("ses_7", {
      hasUnresolvedTask: true,
      isActiveSession: true,
      recoveryExhausted: true,
    })
    expect(isWatchdogEligible(getWatchdogState("ses_7"))).toBe(false)
  })

  it("matrix item 8: superseded by user -> INELIGIBLE if task completed / superseded", () => {
    updateWatchdogState("ses_8", {
      hasUnresolvedTask: true,
      isActiveSession: true,
    })
    watchdogIncidentManager.confirmStall("ses_8")
    watchdogIncidentManager.markSuperseded("ses_8")
    // Incident is superseded
    expect(watchdogIncidentManager.getIncident("ses_8")?.status).toBe("SUPERSEDED")
  })

  it("matrix item 9: old registry entry with no state -> INELIGIBLE (false)", () => {
    expect(isWatchdogEligible(getWatchdogState("non_existent_session"))).toBe(false)
  })

  it("matrix item 10: terminal child -> INELIGIBLE (false)", () => {
    updateWatchdogState("child_1", {
      hasUnresolvedTask: false,
      isTerminalTask: true,
      isActiveSession: false,
    })
    expect(isWatchdogEligible(getWatchdogState("child_1"))).toBe(false)
  })

  it("matrix item 11: active child with unresolved work -> ELIGIBLE (true)", () => {
    updateWatchdogState("child_2", {
      hasUnresolvedTask: true,
      isActiveSession: true,
      isTerminalTask: false,
    })
    expect(isWatchdogEligible(getWatchdogState("child_2"))).toBe(true)
  })

  it("single-flight and STALLED_UNRECOVERED bounded recovery lifecycle", () => {
    updateWatchdogState("ses_bound", {
      hasUnresolvedTask: true,
      isActiveSession: true,
    })

    // Confirm stall 1 -> Directive 1 (inFlight becomes true)
    const r1 = watchdogIncidentManager.confirmStall("ses_bound")
    expect(r1.injectDirective).toBe(true)
    expect(r1.state.recoveryDirectiveCount).toBe(1)
    expect(r1.state.inFlight).toBe(true)

    // Repeat confirmStall while inFlight=true -> SUPPRESSED (false)
    const r1_dup = watchdogIncidentManager.confirmStall("ses_bound")
    expect(r1_dup.injectDirective).toBe(false)

    // Clear inFlight (directive turn finished without progress)
    watchdogIncidentManager.clearInFlight("ses_bound")

    // Confirm stall 2 -> Directive 2
    const r2 = watchdogIncidentManager.confirmStall("ses_bound")
    expect(r2.injectDirective).toBe(true)
    expect(r2.state.recoveryDirectiveCount).toBe(2)

    watchdogIncidentManager.clearInFlight("ses_bound")

    // Confirm stall 3 -> Alternate strategy
    const r3 = watchdogIncidentManager.confirmStall("ses_bound")
    expect(r3.injectDirective).toBe(true)
    expect(r3.materiallyDifferent).toBe(true)

    watchdogIncidentManager.clearInFlight("ses_bound")

    // Confirm stall 4 -> STALLED_UNRECOVERED
    const r4 = watchdogIncidentManager.confirmStall("ses_bound")
    expect(r4.injectDirective).toBe(false)
    expect(r4.state.status).toBe("STALLED_UNRECOVERED")

    // Subsequent ticks emit 0 directives
    const r5 = watchdogIncidentManager.confirmStall("ses_bound")
    expect(r5.injectDirective).toBe(false)
  })
})
