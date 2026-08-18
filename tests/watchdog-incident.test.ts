import { describe, it, expect } from "bun:test"
import { WatchdogIncidentManager } from "../src/services/watchdog-incident"

describe("WATCHDOG INCIDENT LIFECYCLE", () => {
  it("bounded: directives then exactly one new strategy then STALLED_UNRECOVERED (no nag flood)", () => {
    const wd = new WatchdogIncidentManager()
    const r1 = wd.confirmStall("s1")
    expect(r1.injectDirective).toBe(true)
    expect(r1.state.recoveryDirectiveCount).toBe(1)
    const r2 = wd.confirmStall("s1")
    expect(r2.injectDirective).toBe(true)
    expect(r2.state.recoveryDirectiveCount).toBe(2)
    const r3 = wd.confirmStall("s1")
    expect(r3.injectDirective).toBe(true)
    expect(r3.materiallyDifferent).toBe(true)
    const r4 = wd.confirmStall("s1")
    expect(r4.injectDirective).toBe(false)
    expect(r4.state.status).toBe("STALLED_UNRECOVERED")
    // further confirmations stop injecting (no infinite nag loop)
    expect(wd.confirmStall("s1").injectDirective).toBe(false)
    expect(wd.isStalledUnrecovered("s1")).toBe(true)
  })
  it("watchdog prompt does not count as progress and does not reset the incident", () => {
    const wd = new WatchdogIncidentManager()
    wd.confirmStall("s2")
    wd.recordNonProgressActivity("s2")
    wd.recordNonProgressActivity("s2")
    expect(wd.getIncident("s2")!.materiallyDifferentStrategyCount).toBe(0)
    expect(wd.isStalledUnrecovered("s2")).toBe(false)
  })
  it("real progress evidence resolves the incident", () => {
    const wd = new WatchdogIncidentManager()
    wd.confirmStall("s3")
    wd.recordProgressEvidence("s3", "source_changed")
    expect(wd.getIncident("s3")!.status).toBe("RESOLVED")
  })
})