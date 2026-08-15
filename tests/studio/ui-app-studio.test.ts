import { describe, it, expect } from "bun:test";
import { HeidiUiAppStudio } from "../../src/studio/ui-app-studio";
import { classifyStudioIntent } from "../../src/lib/task-routing";
import { runStudioChecks } from "../../src/doctor/checks/studio";

describe("Heidi UI/App Studio Primary Coordinator & Doctor Integration", () => {
  it("classifies natural language Studio intents", () => {
    expect(classifyStudioIntent("Generate UI for analytics page").isStudioTask).toBe(true);
    expect(classifyStudioIntent("Create full stack app for project management").isFullStack).toBe(true);
    expect(classifyStudioIntent("Fix database typo").isStudioTask).toBe(false);
  });

  it("executes full Studio task and emits telemetry events", async () => {
    const studio = new HeidiUiAppStudio();
    const events: string[] = [];

    const result = await studio.executeStudioTask({
      userPrompt: "Build a new analytics dashboard with full stack capabilities",
      isFullStack: true,
      targetComponentName: "AnalyticsDashboard",
      onEvent: (event) => events.push(event),
    });

    expect(result.success).toBe(true);
    expect(result.architecture).toBeDefined();
    expect(result.designSystem).toBeDefined();
    expect(result.responsiveVerification).toHaveProperty("mobile", true);
    expect(result.summary).toContain("AnalyticsDashboard");

    expect(events).toContain("studio.task.started");
    expect(events).toContain("studio.design_system.indexed");
    expect(events).toContain("studio.ui_architecture.generated");
    expect(events).toContain("studio.task.completed");
  });

  it("runs Doctor studio.readiness health check cleanly", async () => {
    const checks = await runStudioChecks(process.cwd());
    expect(checks).toHaveLength(1);
    expect(checks[0].id).toBe("studio.readiness");
    expect(checks[0].status).toBe("pass");
  });
});
