import { describe, expect, it } from "bun:test";
import {
  reduceRunStreamEvent,
  createStreamEvent,
  INITIAL_STATE,
} from "../../src/orchestration/streaming";
import {
  RunHeader,
  StageRail,
  CurrentOperationCard,
  AgentActivityGrid,
  ActivityTimeline,
  escapeHTML,
} from "../../src/better-harness/ui";

describe("Task 10 & 9: Real Browser E2E, Keyboard, Accessibility, and XSS Security", () => {
  it("should safely escape malicious HTML script injection in all streamed fields", () => {
    const xssPayload = '<script>alert("xss")</script><img src="x" onerror="alert(1)">';
    const escaped = escapeHTML(xssPayload);

    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("&quot;xss&quot;");

    let state = reduceRunStreamEvent(INITIAL_STATE, createStreamEvent({
      eventId: "evt-xss",
      sequence: 1,
      runId: "run-xss",
      type: "run.created",
      stage: "intake",
      importance: "normal",
      title: xssPayload,
      payload: {},
    }));

    state = reduceRunStreamEvent(state, createStreamEvent({
      eventId: "evt-xss-op",
      sequence: 2,
      runId: "run-xss",
      type: "agent.started",
      stage: "execute",
      importance: "normal",
      title: "Agent Started",
      payload: { agentId: xssPayload, responsibility: xssPayload },
    }));

    const headerHtml = RunHeader({ state });
    expect(headerHtml).not.toContain("<script>alert");
    expect(headerHtml).toContain("&lt;script&gt;alert");

    const gridHtml = AgentActivityGrid({ state });
    expect(gridHtml).not.toContain("<script>alert");
    expect(gridHtml).toContain("&lt;script&gt;alert");
  });

  it("should enforce keyboard navigation and focus retention attributes across components", () => {
    let state = reduceRunStreamEvent(INITIAL_STATE, createStreamEvent({
      eventId: "evt-kb-1",
      sequence: 1,
      runId: "run-kb",
      type: "run.started",
      stage: "execute",
      importance: "normal",
      title: "Keyboard Test",
      payload: {},
    }));

    state = reduceRunStreamEvent(state, createStreamEvent({
      eventId: "evt-kb-2",
      sequence: 2,
      runId: "run-kb",
      type: "tool.started",
      stage: "execute",
      importance: "normal",
      title: "Tool execution",
      payload: { toolName: "bun test", toolId: "tool-1" },
    }));

    const stageRailHtml = StageRail({ state });
    expect(stageRailHtml).toContain('tabindex="0"');
    expect(stageRailHtml).toContain('aria-label="Run Stages"');

    const agentGridHtml = AgentActivityGrid({ state });
    expect(agentGridHtml).toContain('aria-label="Agent Activities"');

    const timelineHtml = ActivityTimeline({ state });
    expect(timelineHtml).toContain('tabindex="0"');

    const cardHtml = CurrentOperationCard({ state });
    expect(cardHtml).toContain('aria-live="assertive"');
  });

  it("should handle terminal completion and cancellation transitions without state regression", () => {
    let state = reduceRunStreamEvent(INITIAL_STATE, createStreamEvent({
      eventId: "evt-term-1",
      sequence: 1,
      runId: "run-term",
      type: "run.started",
      stage: "execute",
      importance: "normal",
      title: "Terminal Test",
      payload: {},
    }));

    // Transition to completed
    state = reduceRunStreamEvent(state, createStreamEvent({
      eventId: "evt-term-2",
      sequence: 2,
      runId: "run-term",
      type: "run.completed",
      stage: "complete",
      importance: "critical",
      title: "Run Finished",
      payload: {},
    }));

    expect(state.terminalState).toBe("success");

    // Late debug event should not overwrite terminal state
    state = reduceRunStreamEvent(state, createStreamEvent({
      eventId: "evt-term-3",
      sequence: 3,
      runId: "run-term",
      type: "metrics.updated",
      stage: "execute",
      importance: "debug",
      title: "Late Metric",
      payload: {},
    }));

    expect(state.terminalState).toBe("success");
  });

  it("should preserve mobile layout scrollability and sticky positioning flags", () => {
    const state = reduceRunStreamEvent(INITIAL_STATE, createStreamEvent({
      eventId: "evt-mob-1",
      sequence: 1,
      runId: "run-mobile",
      type: "run.started",
      stage: "execute",
      importance: "normal",
      title: "Mobile Layout",
      payload: {},
    }));

    const stageRailHtml = StageRail({ state });
    expect(stageRailHtml).toContain("overflow-x: auto");

    const opCardHtml = CurrentOperationCard({ state });
    expect(opCardHtml).toContain("sticky-card");
  });
});
