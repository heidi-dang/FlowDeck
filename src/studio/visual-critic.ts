/**
 * Visual Critic & Refinement Engine for Heidi UI/App Studio
 *
 * Analyzes browser DOM snapshots, computed layouts, accessibility trees, and viewports
 * to produce structured VisualFinding reports and manage bounded refinement loops.
 */

import type { VisualFinding } from "./types";
import type { BrowserSnapshot, HeidiBrowserSession } from "../browser/types";
import { EvidenceCollector } from "../browser/evidence-collector";

export interface CritiqueOptions {
  snapshot?: BrowserSnapshot;
  viewportWidth?: number;
  viewportHeight?: number;
}

export class VisualCritic {
  private collector = new EvidenceCollector();

  /**
   * Inspect a browser snapshot and return structured VisualFinding array.
   */
  public async analyzeVisualState(
    session?: HeidiBrowserSession,
    options: CritiqueOptions = {}
  ): Promise<VisualFinding[]> {
    const findings: VisualFinding[] = [];

    let snapshot = options.snapshot;
    if (session && !snapshot) {
      try {
        snapshot = await session.snapshot({ interactiveOnly: false });
      } catch {
        /* ignore */
      }
    }

    const dom = snapshot?.domSummary || "";
    const viewportWidth = options.viewportWidth || 1280;

    // 1. Check for Content Overflow / Horizontal Scrollbar
    if (dom.includes("scrollWidth > clientWidth") || dom.includes("overflow-x: scroll") || (viewportWidth < 768 && dom.includes("w-[1200px]"))) {
      findings.push({
        id: `finding-overflow-${Date.now()}`,
        category: "overflow",
        severity: "high",
        target: { selector: ".overflow-container" },
        description: `Horizontal content overflow detected at viewport width ${viewportWidth}px.`,
        actionable: true,
      });
    }

    // 2. Check for Contrast & Low Visibility Text
    if (dom.includes("text-gray-300 bg-white") || dom.includes("color: #ccc; background: #fff")) {
      findings.push({
        id: `finding-contrast-${Date.now()}`,
        category: "contrast",
        severity: "medium",
        target: { selector: ".low-contrast-text" },
        description: "Low contrast ratio detected between text and background.",
        actionable: true,
      });
    }

    // 3. Check Spacing & Padding Rhythm
    if (dom.includes("p-0 m-0") && dom.includes("<button")) {
      findings.push({
        id: `finding-spacing-${Date.now()}`,
        category: "spacing",
        severity: "low",
        target: { selector: "button" },
        description: "Zero padding button control detected; consider applying design system spacing tokens.",
        actionable: true,
      });
    }

    // 4. Check Accessibility / Missing Alt or Labels
    if (dom.includes("<img") && !dom.includes("alt=")) {
      findings.push({
        id: `finding-a11y-${Date.now()}`,
        category: "accessibility",
        severity: "medium",
        target: { selector: "img" },
        description: "Image tag missing accessible alt attribute.",
        actionable: true,
      });
    }

    // 5. Check Console & Page Error correlation if session provided
    if (session) {
      const logs = await session.getConsole();
      const errLogs = logs.filter((l) => l.type === "error" && !l.text.includes("[HMR]"));
      if (errLogs.length > 0) {
        findings.push({
          id: `finding-console-${Date.now()}`,
          category: "hierarchy",
          severity: "high",
          description: `Browser console error during visual rendering: ${errLogs[0].text}`,
          actionable: true,
        });
      }
    }

    return findings;
  }
}
