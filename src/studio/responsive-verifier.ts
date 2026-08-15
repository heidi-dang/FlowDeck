/**
 * Responsive Verifier for Heidi UI/App Studio
 *
 * Validates generated UI across Mobile (390x844), Tablet (768x1024), and
 * Desktop (1440x900) viewports to detect overflow, clipping, touch target, and layout issues.
 */

import type { HeidiBrowserSession } from "../browser/types";
import { VisualCritic } from "./visual-critic";

export interface ViewportConfig {
  name: "mobile" | "tablet" | "desktop";
  width: number;
  height: number;
}

export const STANDARD_VIEWPORTS: ViewportConfig[] = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];

export interface ResponsiveVerificationResult {
  mobile: boolean;
  tablet: boolean;
  desktop: boolean;
  allPassed: boolean;
  issues: string[];
}

export class ResponsiveVerifier {
  private critic = new VisualCritic();

  /**
   * Verify responsiveness across standard viewports.
   */
  public async verifyResponsiveLayouts(
    session?: HeidiBrowserSession,
    viewports: ViewportConfig[] = STANDARD_VIEWPORTS
  ): Promise<ResponsiveVerificationResult> {
    const issues: string[] = [];
    const results: Record<string, boolean> = {
      mobile: true,
      tablet: true,
      desktop: true,
    };

    for (const vp of viewports) {
      const findings = await this.critic.analyzeVisualState(session, {
        viewportWidth: vp.width,
        viewportHeight: vp.height,
      });

      const actionableFindings = findings.filter((f) => f.actionable && f.severity === "high");
      if (actionableFindings.length > 0) {
        results[vp.name] = false;
        for (const f of actionableFindings) {
          issues.push(`[${vp.name} ${vp.width}x${vp.height}] ${f.category}: ${f.description}`);
        }
      }
    }

    const allPassed = results.mobile && results.tablet && results.desktop;

    return {
      mobile: results.mobile,
      tablet: results.tablet,
      desktop: results.desktop,
      allPassed,
      issues,
    };
  }
}
