import { describe, it, expect } from "bun:test";
import { UIArchitect } from "../../src/studio/ui-architect";

describe("UIArchitect Subsystem", () => {
  it("determines when structured UI architecture pass is needed", () => {
    const architect = new UIArchitect();

    expect(architect.shouldArchitect("Build a new SaaS analytics dashboard")).toBe(true);
    expect(architect.shouldArchitect("Create full stack admin app")).toBe(true);

    expect(architect.shouldArchitect("Fix typo in button label")).toBe(false);
    expect(architect.shouldArchitect("Add 4px margin to card container")).toBe(false);
  });

  it("constructs a structured UIArchitecture blueprint for dashboard application", () => {
    const architect = new UIArchitect();
    const blueprint = architect.constructArchitecture({
      userPrompt: "Build a new analytics dashboard with settings view",
      existingComponentNames: ["Button", "Card", "Header"],
      designSystemTheme: "professional",
    });

    expect(blueprint.screens.length).toBeGreaterThanOrEqual(2);
    expect(blueprint.navigation.type).toBe("sidebar");
    expect(blueprint.components).toBeDefined();

    const reusedButton = blueprint.components.find((c) => c.name === "Button");
    expect(reusedButton?.reuseExisting).toBe(true);

    expect(blueprint.responsiveStrategy).toHaveProperty("mobileLayout");
    expect(blueprint.responsiveStrategy).toHaveProperty("desktopLayout");
  });
});
