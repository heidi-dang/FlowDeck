import { describe, it, expect } from "bun:test";
import { FullStackBuilder } from "../../src/studio/fullstack-builder";

describe("FullStackBuilder Subsystem & Provider-Neutral Execution Graph", () => {
  it("constructs full-stack execution graph for application spec", () => {
    const builder = new FullStackBuilder();
    const graph = builder.constructExecutionGraph({
      applicationName: "TaskManagementApp",
      databaseProvider: "sqlite",
      authProvider: "auth.js",
      deploymentProvider: "docker",
      apiType: "rest",
    });

    expect(graph.applicationName).toBe("TaskManagementApp");
    expect(graph.providers.database).toBe("sqlite");
    expect(graph.providers.auth).toBe("auth.js");
    expect(graph.providers.deployment).toBe("docker");
    expect(graph.stages.length).toBeGreaterThanOrEqual(5);

    const dbStage = graph.stages.find((s) => s.domain === "database");
    const apiStage = graph.stages.find((s) => s.domain === "backend");
    const uiStage = graph.stages.find((s) => s.domain === "frontend");
    const integrationStage = graph.stages.find((s) => s.domain === "integration");
    const verificationStage = graph.stages.find((s) => s.domain === "verification");

    expect(dbStage).toBeDefined();
    expect(apiStage).toBeDefined();
    expect(uiStage).toBeDefined();
    expect(integrationStage).toBeDefined();
    expect(verificationStage).toBeDefined();
  });
});
