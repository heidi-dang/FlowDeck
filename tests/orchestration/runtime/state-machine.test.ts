import { describe, it, expect, beforeEach, vi } from "bun:test";
import {
  STATES,
  isTerminalState,
  isActiveState,
  getStateCategory,
  TRANSITION_TABLE,
  getAllowedTransitions,
  isTransitionAllowed,
  TransitionService,
  StageEventEmitter,
  terminalStateGuard,
  noSelfTransitionGuard,
  cancellationGuard,
  composeGuards,
  type State,
  type TransitionContext,
  type StageStageEvent,
} from "../../../src/orchestration/runtime/index.js";

describe("State Definitions", () => {
  describe("STATES constant", () => {
    it("should contain all 10 states", () => {
      expect(STATES).toHaveLength(10);
      expect(STATES).toContain("created");
      expect(STATES).toContain("planning");
      expect(STATES).toContain("analysing");
      expect(STATES).toContain("delegating");
      expect(STATES).toContain("executing");
      expect(STATES).toContain("verifying");
      expect(STATES).toContain("recovering");
      expect(STATES).toContain("completed");
      expect(STATES).toContain("failed");
      expect(STATES).toContain("cancelled");
    });
  });

  describe("isTerminalState", () => {
    it("should return true for terminal states", () => {
      expect(isTerminalState("completed")).toBe(true);
      expect(isTerminalState("failed")).toBe(true);
      expect(isTerminalState("cancelled")).toBe(true);
    });

    it("should return false for active states", () => {
      expect(isTerminalState("created")).toBe(false);
      expect(isTerminalState("planning")).toBe(false);
      expect(isTerminalState("analysing")).toBe(false);
      expect(isTerminalState("delegating")).toBe(false);
      expect(isTerminalState("executing")).toBe(false);
      expect(isTerminalState("verifying")).toBe(false);
      expect(isTerminalState("recovering")).toBe(false);
    });
  });

  describe("isActiveState", () => {
    it("should return true for active states", () => {
      for (const state of [
        "created",
        "planning",
        "analysing",
        "delegating",
        "executing",
        "verifying",
        "recovering",
      ] as State[]) {
        expect(isActiveState(state)).toBe(true);
      }
    });

    it("should return false for terminal states", () => {
      expect(isActiveState("completed")).toBe(false);
      expect(isActiveState("failed")).toBe(false);
      expect(isActiveState("cancelled")).toBe(false);
    });
  });

  describe("getStateCategory", () => {
    it("should return 'active' for active states", () => {
      for (const state of [
        "created",
        "planning",
        "analysing",
        "delegating",
        "executing",
        "verifying",
        "recovering",
      ] as State[]) {
        expect(getStateCategory(state)).toBe("active");
      }
    });

    it("should return 'terminal' for terminal states", () => {
      expect(getStateCategory("completed")).toBe("terminal");
      expect(getStateCategory("cancelled")).toBe("terminal");
    });

    it("should return 'error' for error states", () => {
      expect(getStateCategory("failed")).toBe("error");
    });
  });
});

describe("Transition Table", () => {
  describe("Valid Transitions", () => {
    const validTransitions: [State, State][] = [
      ["created", "planning"],
      ["planning", "analysing"],
      ["analysing", "delegating"],
      ["analysing", "executing"],
      ["delegating", "executing"],
      ["executing", "verifying"],
      ["verifying", "completed"],
      ["verifying", "recovering"],
      ["verifying", "executing"],
      ["verifying", "failed"],
      ["recovering", "executing"],
      ["recovering", "failed"],
      ["recovering", "completed"],
    ];

    it.each(validTransitions)("should allow %s -> %s", (from, to) => {
      expect(isTransitionAllowed(from, to)).toBe(true);
    });
  });

  describe("Invalid Transitions", () => {
    const invalidTransitions: [State, State][] = [
      // Skip backwards
      ["planning", "created"],
      ["analysing", "planning"],
      ["delegating", "analysing"],
      ["executing", "delegating"],
      // Skip forward
      ["created", "analysing"],
      ["created", "executing"],
      ["planning", "delegating"],
      ["planning", "executing"],
      ["analysing", "completed"],
      // Terminal states
      ["completed", "created"],
      ["completed", "planning"],
      ["completed", "failed"],
      ["failed", "created"],
      ["failed", "completed"],
      ["cancelled", "created"],
      ["cancelled", "completed"],
    ];

    it.each(invalidTransitions)("should reject %s -> %s", (from, to) => {
      expect(isTransitionAllowed(from, to)).toBe(false);
    });
  });

  describe("getAllowedTransitions", () => {
    it("should return correct transitions for created", () => {
      expect(getAllowedTransitions("created")).toEqual(["planning"]);
    });

    it("should return correct transitions for planning", () => {
      expect(getAllowedTransitions("planning")).toEqual(["analysing"]);
    });

    it("should return correct transitions for analysing", () => {
      expect(getAllowedTransitions("analysing")).toEqual(["delegating", "executing"]);
    });

    it("should return empty array for terminal states", () => {
      expect(getAllowedTransitions("completed")).toEqual([]);
      expect(getAllowedTransitions("failed")).toEqual([]);
      expect(getAllowedTransitions("cancelled")).toEqual([]);
    });
  });
});

describe("Transition Guards", () => {
  const createContext = (): TransitionContext => ({
    runId: "test-run",
    timestamp: Date.now(),
  });

  describe("terminalStateGuard", () => {
    it("should reject transitions from terminal states", () => {
      const context = createContext();
      expect(
        terminalStateGuard("completed", "created", context, "normal")
      ).toEqual({ allowed: false, reason: "Cannot transition from terminal state: completed" });
      expect(
        terminalStateGuard("failed", "created", context, "normal")
      ).toEqual({ allowed: false, reason: "Cannot transition from terminal state: failed" });
      expect(
        terminalStateGuard("cancelled", "created", context, "normal")
      ).toEqual({ allowed: false, reason: "Cannot transition from terminal state: cancelled" });
    });

    it("should allow transitions from active states", () => {
      const context = createContext();
      expect(
        terminalStateGuard("created", "planning", context, "normal")
      ).toEqual({ allowed: true });
      expect(
        terminalStateGuard("executing", "verifying", context, "normal")
      ).toEqual({ allowed: true });
    });
  });

  describe("noSelfTransitionGuard", () => {
    it("should reject self-transitions", () => {
      const context = createContext();
      expect(
        noSelfTransitionGuard("created", "created", context, "normal")
      ).toEqual({ allowed: false, reason: "Self-transition not allowed: created -> created" });
      expect(
        noSelfTransitionGuard("executing", "executing", context, "normal")
      ).toEqual({ allowed: false, reason: "Self-transition not allowed: executing -> executing" });
    });

    it("should allow non-self transitions", () => {
      const context = createContext();
      expect(
        noSelfTransitionGuard("created", "planning", context, "normal")
      ).toEqual({ allowed: true });
    });
  });

  describe("cancellationGuard", () => {
    it("should allow cancellation from non-terminal states", () => {
      const context = createContext();
      for (const state of ["created", "planning", "analysing", "delegating", "executing", "verifying", "recovering"] as State[]) {
        expect(
          cancellationGuard(state, "cancelled", context, "forced")
        ).toEqual({ allowed: true });
      }
    });

    it("should reject cancellation from terminal states", () => {
      const context = createContext();
      expect(
        cancellationGuard("completed", "cancelled", context, "forced")
      ).toEqual({ allowed: false, reason: "Cannot cancel from terminal state: completed" });
      expect(
        cancellationGuard("failed", "cancelled", context, "forced")
      ).toEqual({ allowed: false, reason: "Cannot cancel from terminal state: failed" });
      expect(
        cancellationGuard("cancelled", "cancelled", context, "forced")
      ).toEqual({ allowed: false, reason: "Cannot cancel from terminal state: cancelled" });
    });
  });

  describe("composeGuards", () => {
    it("should run all guards in order", () => {
      const guard1 = vi.fn((from: State, to: State, ctx: TransitionContext) => ({ allowed: true }));
      const guard2 = vi.fn((from: State, to: State, ctx: TransitionContext) => ({ allowed: true }));
      const composed = composeGuards(guard1, guard2);
      const context = createContext();

      composed("created", "planning", context, "normal");

      expect(guard1).toHaveBeenCalledWith("created", "planning", context, "normal");
      expect(guard2).toHaveBeenCalledWith("created", "planning", context, "normal");
    });

    it("should stop at first failing guard", () => {
      const guard1 = vi.fn((from: State, to: State, ctx: TransitionContext) => ({
        allowed: false,
        reason: "Guard 1 failed",
      }));
      const guard2 = vi.fn((from: State, to: State, ctx: TransitionContext) => ({ allowed: true }));
      const composed = composeGuards(guard1, guard2);
      const context = createContext();

      const result = composed("created", "planning", context, "normal");

      expect(result).toEqual({ allowed: false, reason: "Guard 1 failed" });
      expect(guard2).not.toHaveBeenCalled();
    });
  });
});

describe("TransitionService", () => {
  let service: TransitionService;
  let eventEmitter: StageEventEmitter;
  let emittedEvents: ReturnType<typeof service.subscribe>[];

  beforeEach(() => {
    eventEmitter = new StageEventEmitter();
    service = new TransitionService({ eventEmitter });
    emittedEvents = [];
  });

  describe("canTransition", () => {
    it("should return true for valid transitions", () => {
      const context = { runId: "test", timestamp: Date.now() };
      expect(service.canTransition("created", "planning", context)).toBe(true);
      expect(service.canTransition("planning", "analysing", context)).toBe(true);
      expect(service.canTransition("executing", "verifying", context)).toBe(true);
    });

    it("should return false for invalid transitions", () => {
      const context = { runId: "test", timestamp: Date.now() };
      expect(service.canTransition("created", "executing", context)).toBe(false);
      expect(service.canTransition("planning", "created", context)).toBe(false);
      expect(service.canTransition("completed", "created", context)).toBe(false);
    });
  });

  describe("executeTransition", () => {
    it("should successfully transition with events", () => {
      const listener = vi.fn();
      eventEmitter.subscribe(listener);

      const context = { runId: "test-run", timestamp: Date.now() };
      const result = service.executeTransition("test-run", "created", "planning", context);

      expect(result.success).toBe(true);
      expect(result.from).toBe("created");
      expect(result.to).toBe("planning");
      expect(listener).toHaveBeenCalled();
    });

    it("should emit StageExited and StageEntered events", () => {
      const events: StageStageEvent[] = [];
      eventEmitter.subscribe((e: StageStageEvent) => events.push(e));

      const context = { runId: "test-run", timestamp: Date.now() };
      service.executeTransition("test-run", "created", "planning", context);

      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ type: "StageExited", state: "created", nextState: "planning" });
      expect(events[1]).toMatchObject({ type: "StageEntered", state: "planning", previousState: "created" });
    });

    it("should fail for invalid transitions", () => {
      const context = { runId: "test-run", timestamp: Date.now() };
      const result = service.executeTransition("test-run", "created", "executing", context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid transition");
    });

    it("should fail for terminal state transitions", () => {
      const context = { runId: "test-run", timestamp: Date.now() };
      const result = service.executeTransition("test-run", "completed", "created", context);

      expect(result.success).toBe(false);
      expect(result.error).toContain("terminal state");
    });
  });

  describe("Terminal State Protection", () => {
    it("should protect completed state", () => {
      const context = { runId: "test-run", timestamp: Date.now() };
      expect(service.canTransition("completed", "created", context)).toBe(false);
      expect(service.canTransition("completed", "failed", context)).toBe(false);
    });

    it("should protect failed state", () => {
      const context = { runId: "test-run", timestamp: Date.now() };
      expect(service.canTransition("failed", "created", context)).toBe(false);
      expect(service.canTransition("failed", "completed", context)).toBe(false);
    });

    it("should protect cancelled state", () => {
      const context = { runId: "test-run", timestamp: Date.now() };
      expect(service.canTransition("cancelled", "created", context)).toBe(false);
      expect(service.canTransition("cancelled", "completed", context)).toBe(false);
    });
  });

  describe("Cancellation in Every Active State", () => {
    const activeStates: State[] = [
      "created",
      "planning",
      "analysing",
      "delegating",
      "executing",
      "verifying",
      "recovering",
    ];

    it.each(activeStates)("should allow cancellation from %s", (state) => {
      const context = { runId: "test-run", timestamp: Date.now() };
      expect(service.canTransition(state, "cancelled", context)).toBe(true);
    });

    it.each(activeStates)("should execute cancellation from %s", (state) => {
      const events: StageStageEvent[] = [];
      eventEmitter.subscribe((e: StageStageEvent) => events.push(e));

      const context = { runId: "test-run", timestamp: Date.now() };
      const result = service.executeTransition("test-run", state, "cancelled", context);

      expect(result.success).toBe(true);
      expect(result.to).toBe("cancelled");
    });
  });
});

describe("Full Transition Matrix Coverage", () => {
  let service: TransitionService;
  const context = { runId: "test-run", timestamp: Date.now() };

  beforeEach(() => {
    service = new TransitionService();
  });

  const allTransitions: [State, State, boolean][] = [
    // Normal forward flow
    ["created", "planning", true],
    ["planning", "analysing", true],
    ["analysing", "delegating", true],
    ["analysing", "executing", true],
    ["delegating", "executing", true],
    ["executing", "verifying", true],
    ["verifying", "completed", true],
    ["verifying", "recovering", true],
    ["verifying", "executing", true],
    ["verifying", "failed", true],
    ["recovering", "executing", true],
    ["recovering", "failed", true],
    ["recovering", "completed", true],
    // Cancellation from active states
    ["created", "cancelled", true],
    ["planning", "cancelled", true],
    ["analysing", "cancelled", true],
    ["delegating", "cancelled", true],
    ["executing", "cancelled", true],
    ["verifying", "cancelled", true],
    ["recovering", "cancelled", true],
    // Invalid transitions
    ["created", "analysing", false],
    ["created", "executing", false],
    ["created", "verifying", false],
    ["created", "completed", false],
    ["created", "failed", false],
    ["planning", "delegating", false],
    ["planning", "executing", false],
    ["planning", "verifying", false],
    ["planning", "completed", false],
    ["planning", "failed", false],
    ["analysing", "verifying", false],
    ["analysing", "completed", false],
    ["analysing", "failed", false],
    ["delegating", "verifying", false],
    ["delegating", "completed", false],
    ["delegating", "failed", false],
    ["executing", "completed", false],
    ["executing", "failed", false],
    ["executing", "recovering", false],
    ["verifying", "planning", false],
    ["verifying", "analysing", false],
    ["recovering", "planning", false],
    ["recovering", "analysing", false],
    ["recovering", "delegating", false],
    ["recovering", "verifying", false],
    // Backward transitions
    ["planning", "created", false],
    ["analysing", "planning", false],
    ["analysing", "created", false],
    ["delegating", "analysing", false],
    ["delegating", "planning", false],
    ["executing", "delegating", false],
    ["executing", "analysing", false],
    ["executing", "planning", false],
    ["executing", "created", false],
    ["verifying", "delegating", false],
    ["verifying", "analysing", false],
    ["verifying", "planning", false],
    ["verifying", "created", false],
    ["recovering", "verifying", false],
    ["recovering", "delegating", false],
    ["recovering", "analysing", false],
    ["recovering", "planning", false],
    ["recovering", "created", false],
    // Terminal state transitions
    ["completed", "created", false],
    ["completed", "planning", false],
    ["completed", "analysing", false],
    ["completed", "delegating", false],
    ["completed", "executing", false],
    ["completed", "verifying", false],
    ["completed", "recovering", false],
    ["completed", "failed", false],
    ["completed", "cancelled", false],
    ["failed", "created", false],
    ["failed", "planning", false],
    ["failed", "analysing", false],
    ["failed", "delegating", false],
    ["failed", "executing", false],
    ["failed", "verifying", false],
    ["failed", "recovering", false],
    ["failed", "completed", false],
    ["failed", "cancelled", false],
    ["cancelled", "created", false],
    ["cancelled", "planning", false],
    ["cancelled", "analysing", false],
    ["cancelled", "delegating", false],
    ["cancelled", "executing", false],
    ["cancelled", "verifying", false],
    ["cancelled", "recovering", false],
    ["cancelled", "completed", false],
    ["cancelled", "failed", false],
  ];

  it.each(allTransitions)("transition %s -> %s should be %s", (from, to, expected) => {
    expect(service.canTransition(from, to, context)).toBe(expected);
  });
});
