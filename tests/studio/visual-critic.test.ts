import { describe, it, expect } from "bun:test";
import { VisualCritic } from "../../src/studio/visual-critic";

describe("VisualCritic Subsystem", () => {
  it("analyzes browser snapshot and identifies visual, contrast, and spacing issues", async () => {
    const critic = new VisualCritic();

    const findings = await critic.analyzeVisualState(undefined, {
      viewportWidth: 375,
      snapshot: {
        url: "http://localhost:3000/app",
        title: "Test App",
        domSummary: '<div className="overflow-x: scroll w-[1200px]"><span className="text-gray-300 bg-white">Low contrast</span><img src="logo.png" /><button className="p-0 m-0">Click</button></div>',
      },
    });

    expect(findings.length).toBeGreaterThanOrEqual(3);

    const overflow = findings.find((f) => f.category === "overflow");
    const contrast = findings.find((f) => f.category === "contrast");
    const spacing = findings.find((f) => f.category === "spacing");
    const a11y = findings.find((f) => f.category === "accessibility");

    expect(overflow).toBeDefined();
    expect(contrast).toBeDefined();
    expect(spacing).toBeDefined();
    expect(a11y).toBeDefined();
  });
});
