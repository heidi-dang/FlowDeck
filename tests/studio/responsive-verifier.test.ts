import { describe, it, expect } from "bun:test";
import { ResponsiveVerifier, STANDARD_VIEWPORTS } from "../../src/studio/responsive-verifier";

describe("ResponsiveVerifier Subsystem", () => {
  it("verifies responsive layouts across Mobile (390x844), Tablet (768x1024), and Desktop (1440x900)", async () => {
    const verifier = new ResponsiveVerifier();
    const res = await verifier.verifyResponsiveLayouts(undefined, STANDARD_VIEWPORTS);

    expect(res).toHaveProperty("mobile");
    expect(res).toHaveProperty("tablet");
    expect(res).toHaveProperty("desktop");
    expect(res).toHaveProperty("allPassed");
    expect(Array.isArray(res.issues)).toBe(true);
  });
});
