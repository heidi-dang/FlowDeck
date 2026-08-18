import { describe, it, expect } from "bun:test"
import { EmptyTerminalCircuitManager } from "../src/services/empty-terminal-circuit"

describe("EMPTY TERMINAL RECOVERY CIRCUIT", () => {
  it("bounded silent recovery with finite invariant and one final diagnostic", () => {
    const circuit = new EmptyTerminalCircuitManager({ maxConsecutiveEmpty: 3, sessionLimit: 4 })
    const d1 = circuit.recordEmptyTerminal("s1", "m1")
    expect(d1.action).toBe("silent_continue")
    const d2 = circuit.recordEmptyTerminal("s1", "m2")
    expect(d2.action).toBe("compact_and_continue")
    const d3 = circuit.recordEmptyTerminal("s1", "m3")
    expect(d3.action).toBe("strategy_reset")
    const d4 = circuit.recordEmptyTerminal("s1", "m4")
    expect(d4.action).toBe("circuit_break")
    expect(d4.diagnosticMessage).toBeDefined()
  })
  it("no infinite continuation: circuit_break is stable and terminal", () => {
    const circuit = new EmptyTerminalCircuitManager({ maxConsecutiveEmpty: 1, sessionLimit: 2 })
    circuit.recordEmptyTerminal("s2", "a")
    const d = circuit.recordEmptyTerminal("s2", "b")
    expect(d.action).toBe("circuit_break")
    const again = circuit.recordEmptyTerminal("s2", "c")
    expect(again.action).toBe("circuit_break")
  })
  it("genuine semantic progress resolves the incident", () => {
    const circuit = new EmptyTerminalCircuitManager({ maxConsecutiveEmpty: 3, sessionLimit: 5 })
    circuit.recordEmptyTerminal("s3", "a")
    circuit.recordEmptyTerminal("s3", "b")
    circuit.recordSemanticProgress("s3", ["source changed"])
    // after progress the incident is resolved and counter resets
    const d = circuit.recordEmptyTerminal("s3", "c")
    expect(d.action).toBe("silent_continue")
    expect(circuit.getIncident("s3")!.consecutiveEmptyCount).toBe(1)
  })
  it("random tool execution alone does NOT reset the incident", () => {
    const circuit = new EmptyTerminalCircuitManager({ maxConsecutiveEmpty: 2, sessionLimit: 3 })
    circuit.recordEmptyTerminal("s4", "a")
    // tool activity is not progress; the incident must keep escalating
    const d2 = circuit.recordEmptyTerminal("s4", "b")
    expect(d2.action).not.toBe("silent_continue")
    const d3 = circuit.recordEmptyTerminal("s4", "c")
    expect(d3.action).toBe("circuit_break")
  })
})